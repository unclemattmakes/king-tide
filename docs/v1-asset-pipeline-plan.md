# King Tide — v1 Asset Pipeline & Production Plan

> Tech-artist read of the work outlined in
> [v1-work-breakdown.md](./v1-work-breakdown.md) and the content
> bible in [track-themes.md](./track-themes.md). The *what* and *why*
> live there; this doc is the *with what tools, in what order*.
> Procedural-first by preference — hand-authoring is the exception,
> not the rule.

## Asset surface — at a glance

| Bucket | Count | Notes |
|---|---|---|
| Tracks | 12 (1 tutorial + 11 ship) | Each = layout + set-piece + env kit + sky + AI line + audio palette |
| Hero set-pieces | 11 named | One postcard moment per track |
| Bike variants | 2 new (3 → 5) | Existing per-`bike.blend` pipeline scales |
| Music | 12 tracks (~3 min) | Licensed/commissioned, not procedural |
| Ambient beds | 12 | Layered loops, procedurally mixable |
| Track VFX | ~15 distinct | Lava, neon, oxidation, torch, crane swing, palm sway, gulls, motes |
| UI art | 12 loading screens + bike-select thumbnails | Render-time procedural |

Most of this is geometry + shading. Music + bike modelling are the
genuinely non-procedural items.

## What the pipeline already gets right

Worth naming explicitly so the gap analysis is fair:

- **Spec → GLB round-trip** is rock-solid. `bikes-src/<id>.blend` and
  `tracks-src/<id>.blend` both export one-click via the addon; specs
  carry recolour overrides without touching geometry.
- **Seven biome templates** ship: island, mesa, alpine, dunes, downtown,
  tunnel-island, tunnels. Each is a parametric `HV_*` Geometry Nodes
  graph driven by paired empties. `track_build_lib.build_track_from_spec()`
  is a 50-line entry point for a new biome track.
- **Procedural props library** with `EXT_mesh_gpu_instancing` round-trip
  → `THREE.InstancedMesh` on the runtime. 800 palms cost roughly 1.
- **Vertex-attribute contract** locked: `COLOR_0 = (sway, AO, path-worn/phase, biome)`
  mirrored across Blender + runtime.
- **Foliage sway shader hook** ([foliage-sway.ts](../src/engine/render/foliage-sway.ts))
  reads `COLOR_0.r` × wind uniform.
- **Authoring tools that act like a level editor**: road tool with
  banking + F1 curbs + terrain conform, ramp tool, tunnel Boolean,
  heightmap import, snap-to-terrain, snap-starts-to-spline,
  reverse-spline (re-anchors the start grid + flips gate previews),
  curve-constrained placement helper, live spline-edit previews.
- **OceanFFT renderer** ([src/engine/render/ocean-fft/](../src/engine/render/ocean-fft/))
  with foam-feedback already exists — wave-mastery's *render* layer is built.
- **Landmark library scaffold** ([tools/blender/seed_landmarks_library.py](../tools/blender/seed_landmarks_library.py))
  with 8 Seattle archetypes. The *pattern* (seed → asset-marked
  collections → drag from Asset Browser) is the right home for the
  v1 hero set-pieces.

The repo is in better shape for procedural production than the
work-breakdown's prose suggests. The remaining gaps are concentrated
in three areas: **gameplay-relevant water authoring**, **per-track
look targeting**, and **landmark/VFX coverage**.

---

## Pipeline gaps (ranked by leverage)

### 1. Wave-zone authoring — **highest leverage**

**Problem.** Wave-mastery is the locked pillar, but the wave field is
*globally uniform*. The Maw needs a directional swell hammering the
central arch; Aqualand needs a **timed surge** flooding the lowest
concourse on a fixed 30 s cycle; South Beach needs gentle lagoon;
Hatteras needs heavier Atlantic chop in one half-loop. Today, all of
that is one knob.

**Fix.** New `kind = "wave_zone"` empty:

```
wave_zone_NN  (empty cube)
  extras: {
    kind: "wave_zone",
    height_mult: 1.5,        // multiplies global wave_height
    freq_mult: 1.0,
    direction_deg: 270,      // optional override
    surge_period_s: 30,      // optional — Aqualand tsunami timer
    surge_amplitude: 4.0,
    blend_radius_m: 20       // soft edge so zones don't pop
  }
```

Render side: sample zones in the existing OceanFFT amplitude pass.
Sim side: same lookup in `wave-field.ts`. Authoring side: a `WaveZone`
section in the King Tide sidebar with `Add Wave Zone` / live wireframe
preview that scrubs amplitude in viewport.

**Unblocks:** every wave-heavy track (Maw, Hatteras, Aqualand, Liberty,
Cape Town) — *six of eleven* ship tracks plus the tutorial.

**Effort.** Medium. ~2 days. Wire format + Blender side + runtime
blend = 3 self-contained pieces.

### 2. Hero-landmark library extension — **second-highest**

**Problem.** The shipping `landmarks-library.blend` is Seattle-shaped
(Space Needle, Smith Tower, Lumen). None of the v1 hero set-pieces
have a parametric source. Hand-modelling 11 bespoke landmarks is
where this project burns weeks.

**Fix.** Extend `seed_landmarks_library.py` (or sibling
`seed_landmarks_v1.py`) with **seven recurring archetypes** that
cover 10 of the 11 set-pieces:

| Archetype | Drives | Parameters |
|---|---|---|
| `tower_cylinder_spiral` | Hatteras lighthouse, Doge's Campanile, Angkor central spire, Cocoon Tower face | height, base/cap radius, stripe pattern (spiral/checker/criss-cross), aperture (lamp room / belfry) |
| `arch_ruin` | The Maw × 3 arches, Rialto, Two Oceans roof, Liberty's broken torch arm | span, rise, thickness, decay-amount (irregularity noise), oxidation tint |
| `drowned_facade` | South Beach Art Deco hotels, Manhattan rooftops, Venice palazzi, Shibuya skyscraper tops | style enum (`art_deco`/`tokyo`/`venice`/`nyc`), window grid, depth, signage slot |
| `carved_face_block` | Bayon smiling faces × 16, reusable as relief | size, expression seed, weathering |
| `glass_tank_broken` | Two Oceans Aquarium, Shibuya Crossing window-down view | volume, shatter pattern, optional contents prop (shark, taxis, hachiko) |
| `mechanical_rig` | Marina Bay gantry cranes, Liberty torch flame, Doge's bell | base mount, swing arm, swing-period extras for runtime animation |
| `lava_river_strip` | Kilauea lava waterfall | curve-driven channel + emissive vertex stream |

Plus one bespoke hero: **Statue of Liberty herself** — the finale's
postcard. This one earns its hand-modelling time. Worth ~3 days of
focused Blender; everything else can be procedural.

**Authoring loop**: drag-from-Asset-Browser into the track .blend,
scale/recolour, done. Same flow as the existing prop library.

**Effort.** Medium-high. ~5 days for seven archetypes + 3 days for
Liberty. Saves ~20 days of bespoke modelling downstream.

### 3. Anti-grav ribbon tool — **unblocks 7 of 11 tracks**

**Problem.** Anti-grav segments are authored as "tag this mesh and
hope." Seven ship tracks have an anti-grav stretch (light to heavy).
Each is a different shape: corkscrew, loop, wall-ride, Möbius,
straight-up climb. No common authoring path.

**Fix.** Curve-driven addon operator:

1. Author a Bezier through the desired path.
2. Select cross-section profile (tube / ribbon / banked-strip).
3. *Build Anti-Grav Surface* sweeps the profile, generates the entry
   trigger volume + exit volume at the curve endpoints, tags the
   mesh `kind=track` with `anti_grav=true` extras.

Mirrors the road tool's shape exactly. The hard part (controller flip
+ entry detection) already shipped.

**Unblocks**: Hatteras (lighthouse corkscrew), Shibuya (wall-ride),
Kilauea (caldera loop), Doge's (Campanile climb), Angkor (spire), and
both of Liberty's surfaces (torch arm Möbius + crown interior).

**Effort.** Low-medium. ~1.5 days. Most of the math reuses road-tool
sample functions.

### 4. Per-track sky/grade preset — **multiplies all art value**

**Partially shipped 2026-05-18.** Per-track `horizon` block + bespoke
`horizon_ring` Blender mesh now land — runtime precedence is
(GLB-authored mesh) → (track JSON horizon block) → (procedural seeded
off track id). Authors can either tune the procedural fallback from
the addon's Horizon sub-panel or drop a starter ring, tab into edit
mode, and shape it into a recognisable skyline (Skytree, Table
Mountain). See `docs/blender-pipeline-guide.md` § Horizon.

Still outstanding under this gap: the broader sky-tint / grade /
fog / sun-angle preset block.

**Problem.** Each track has a *locked* colour story: South Beach
pastel sunset, Hatteras Atlantic gray, Maw golden-hour, Shibuya hot
neon night, Liberty sunset finale. The runtime's `sky.ts` +
`horizon-ring.ts` + `cloud-shadows.ts` + terrain shader all support
tunable uniforms but there's no place to *put* the per-track values
for the rest of the atmosphere knobs.

**Fix.** A `sky` block in the track JSON:

```jsonc
{
  "sky": {
    "preset": "golden_hour",         // or 'custom'
    "sunAngleDeg": 18,
    "sunColor": "#ffdb8a",
    "ambientColor": "#3b4a6b",
    "fogColor": "#a4c4dd",
    "fogDensity": 0.0008,
    "cloudCover": 0.35,
    "seaStateBeaufort": 4,            // feeds OceanFFT amplitude
    "bloom": 0.6,
    "colorGrade": "miami_pastel"      // LUT name; bundled set
  }
}
```

Addon panel writes them; runtime reads them at boot.

**Effort.** Low. ~1 day. Mostly schema + UI; the shader uniforms
already exist.

### 5. Path-worn racing line — **free polish on every track**

**Problem.** `COLOR_0.B` is reserved per the vertex-attribute spec
but stamped at 0. The terrain shader could darken/wear a visible
groove along the AI spline at zero gameplay cost.

**Fix.** *Bake Path-Worn* operator: distance-to-spline mask written
into `COLOR_0.B` at export. Already on the
[blender-wishlist.md](./blender-wishlist.md) next-wave list — earn it
now since every v1 track benefits.

**Effort.** Low. ~0.5 day. ~50 lines of `bpy`.

### 6. Particle emitter as authored kind — **VFX system unifier**

**Problem.** The v1 work-breakdown lists ~15 named VFX (wave-pump
flash, anti-grav trails, lava steam, lighthouse beam, neon glow,
crane shadow, bell ripple, torch flame, oxidation shimmer, palm
sway, jungle motes, gull flocks, ferry-wake foam, container rust
streaks, tsunami spray). Today each is a one-off render system or
doesn't exist. WebGPU constraint (learned the hard way in the v1 VFX
work): must be `SpriteNodeMaterial + InstancedMesh`, no `ShaderMaterial`,
no `THREE.Points`.

**Fix.** Single emitter abstraction. Blender side: `kind = "emitter"`
empty with extras `{ count, lifetime_s, emit_rate, velocity_cone_deg,
speed_min/max, color_start, color_end, size_start, size_end,
sprite_atlas, atlas_cell }`. Runtime: one general-purpose
`SpriteNodeMaterial + InstancedMesh` particle system reads the
extras at GLB load and spawns. Each track authors three to six
emitters; the system handles the rest.

The atlas: one shared 1024×1024 sprite sheet with 16 cells
(soft spark, smoke puff, ember, foam droplet, dust mote, gull
silhouette, leaf, neon glare, ash, water spray, glow halo, motion
streak, +4 spare). Procedurally generated once via a Blender bake
script. Every track VFX picks a cell.

**Effort.** Medium-high. ~3 days for atlas + system + Blender kind.
Pays for every VFX line item in one shot.

### 7. Wave-pump zone hints for AI — **AI-feel rescue**

**Shipped 2026-05-19.** Closes the last open Phase A gap. Took the
"simpler" derivation called out in the original Fix: a new pure
module [src/game/ai/pump-hints.ts](../src/game/ai/pump-hints.ts)
walks each AI spline against the track's `wave_zone_NN` list at
track-load time (lazy `WeakMap<Track, …>` cache) and flags spline
indices that lie inside any zone whose `heightMult > 1.2`. The
flag set honours the zone's `blendRadiusM` soft edge so the AI
arms its pump as it enters the smoothstep ring rather than waiting
for the hard OBB face.

Per tick in [src/game/systems/ai-control.ts](../src/game/systems/ai-control.ts):
when the AI's current spline cursor is on a hint AND the smoothed
local surface vy (via `sampleSurface(waveField, …)`, the same call
buoyancy uses) clears a difficulty-tuned threshold AND speed ≥ 45%
of top-speed, the controller sets `intent.pitch =
pumpPitchStrength` for 100 ms (same nose-up input the player taps
with E), then locks out for 500 ms — matches the player wave-pump
observer's `cooldownMs`. Per-difficulty tuning lives in
[src/game/ai/difficulty.ts](../src/game/ai/difficulty.ts):

- **Casual:** `pumpVyThreshold = Infinity` → branch short-circuits,
  the AI never pumps (collapses to "newer driver who hasn't
  internalised wave-mastery yet"). Zero per-tick cost.
- **Standard:** `pumpVyThreshold = 1.5`, `pumpPitchStrength = 0.5`
  — mirrors the player observer's `minVy` so the AI fires in the
  same vy band where a player's pump would register.
- **Hard:** `pumpVyThreshold = 0.6`, `pumpPitchStrength = 0.8` —
  fires off smaller crests with a sharper pitch flick, the
  intended "Hard AI pumps where you do" feel.

20 new unit tests across [tests/unit/pump-hints.test.ts](../tests/unit/pump-hints.test.ts)
(11 cases — empty zones, OBB inside/outside, blend-radius soft
edge, low-heightMult ignore, multi-zone union, yawed-OBB
orientation, `hasAnyHints` fast-path) and additions to
[tests/unit/bike-variants.test.ts](../tests/unit/bike-variants.test.ts)
+ implicit coverage in the existing AI-difficulty test file. **Phase
A now fully shipped (10 of 10 gaps).**

### 8. Headless thumbnail / loading-screen render — **UI polish for free**

**Problem.** 12 track-select tiles + 12 loading screens + 5 bike-
select cards need art. Hand-rendering is fine; doing it
*reproducibly* matters more.

**Fix.** `camera_hero` empty in each `.blend`. Headless render script
`render_track_thumbnail.py` opens the `.blend`, sets the hero camera,
renders a 1280×720 JPG at export to `public/assets/tracks/<id>-hero.jpg`.
Same for bikes via the existing `?viewer=<id>` route — playwright
screenshot at a locked angle.

**Effort.** Low. ~1 day for both render scripts + manifest wiring.

### 9. CI track lint — **catches authoring bugs before merge**

**Problem.** The addon already has a lint pass; CI doesn't run it.
A merged `.blend` with a busted spline or missing start fails at
runtime instead of at PR review.

**Fix.** Add `pnpm gen:tracks:validate` to the asset-pipeline workflow:
opens each `tracks-src/<id>.blend` headless, invokes the addon's
lint operator, fails the build on errors.

**Effort.** Low. ~0.5 day.

### 10. Audio palette schema — **closes the per-track audio loop**

**Problem.** 12 ambient beds + 12 music tracks need somewhere to
*live* in track config. Music is licensed; ambient beds can be
layered loops from a shared SFX bank.

**Fix.** `audio` block in track JSON:

```jsonc
{
  "audio": {
    "music": "south-beach-vaporwave.opus",
    "ambient": ["gulls.opus", "surf-light.opus", "neon-hum.opus"],
    "ambientGains": [0.4, 0.6, 0.2],
    "music3dEffects": { "duckOnPump": 0.35 }
  }
}
```

Music asset can be a `null` placeholder while procedural pad bed
stands in. Audio service picks up new fields without an engine
rewrite (four-bus mixer already routes via `audio-service`).

**Effort.** Low. ~0.5 day. Schema + loader + finish-overlay carry.

---

## Procedural-first principles

These rules govern *how* the asset work happens, not what gets built:

1. **Silhouette before surface.** Land each set-piece as a recognisable
   block-out (one big mass + one or two readable secondary forms)
   before any material work. Eight of the v1 tracks have a single
   landmark that *is* the postcard — that silhouette has to read at
   race-pace viewing distance.
2. **Parametric or procedural everywhere defensible.** New geometry
   gets a Geometry Nodes graph or a `seed_*.py` script unless it's a
   one-off hero (Liberty herself).
3. **Hand-tuning happens *after* the seed runs**, in Blender, on the
   .blend the seed produces. Re-running the seed nukes the file —
   accept it; sources of truth are the seed scripts plus the `.blend`
   you don't re-seed.
4. **Stand on the asset libraries.** Drag from `props-library.blend`
   and `landmarks-library.blend` first. Author bespoke geometry only
   when no archetype fits.
5. **One shader per family, parameter-driven.** `mat_landmark_concrete`
   handles every concrete tower; vertex-color masks differentiate.
   Same rule for `mat_facade_*`, `mat_water_*`, `mat_foliage_*`.
6. **Stay inside the export contract.** New kinds get added to
   `kingtide_kinds.py` AND `asset-kinds.ts` in the same PR — the CI
   test enforces parity.
7. **Cap fidelity at "reads correctly at 40 m/s, 60 fps."** The
   target framerate is the design budget; chasing screenshots above
   the playable budget is wasted effort.

---

## Plan of attack — phased

Phasing aligned to the work-breakdown's track-production sprints
(M13 / M14 / M15). The pipeline gaps land first; tracks production
follows in parallel waves.

### Phase A — Pipeline foundation (1.5 weeks, before M13)

**Shipped 2026-05-19** (10 of 10 gaps; AI pump-hint binding closed
the row). Land the *cross-cutting* infrastructure so every track
sprint benefits. Order by leverage.

| # | Item | Days | Unblocks |
|---|---|---|---|
| 1 | Wave-zone authoring (gap 1) ✅ + AI pump-hint binding (gap 7) ✅ | 2.5 | All 11 ship tracks + tutorial |
| 2 | Anti-grav ribbon tool (gap 3) ✅ | 1.5 | 7 ship tracks |
| 3 | Per-track sky/grade preset (gap 4) ✅ | 1 | All 12 |
| 4 | Particle emitter kind + sprite atlas (gap 6) ✅ | 3 | All track VFX |
| 5 | Path-worn bake (gap 5) ✅ | 0.5 | All terrain |
| 6 | Audio palette schema (gap 10) ✅ | 0.5 | All 12 + audio sprint |
| 7 | Thumbnail render script (gap 8) ✅ | 1 | UI screens |
| 8 | CI track lint (gap 9) ✅ | 0.5 | All authoring |

**Definition of done for Phase A:** a brand-new track `.blend` can
fully author its wave behaviour, anti-grav segments, sky/grade,
emitters, and audio palette without leaving Blender, and the
resulting GLB+JSON survives a CI lint pass. ✅ Met.

### Phase B — Hero-landmark library (1.5 weeks, parallel with A's tail)

Build the seven archetypes from gap 2. Each ships as one collection
in `landmarks-library.blend` (extending the existing eight Seattle
archetypes — same seed pattern), marked as a Blender Asset.

Order to maximise track unblocks per archetype landing:

1. `tower_cylinder_spiral` — 4 tracks (Hatteras, Doge's, Angkor,
   Shibuya partial). 1 day.
2. `arch_ruin` — 4 tracks (Maw, Doge's Rialto, Two Oceans roof,
   Liberty torch). 1 day.
3. `drowned_facade` (4 style variants) — 5 tracks. 2 days.
4. `glass_tank_broken` — 2 tracks (Cape Town, Shibuya). 0.5 day.
5. `mechanical_rig` — 2 tracks (Marina Bay, Doge's, Liberty torch
   flame). 1 day.
6. `carved_face_block` — 1 track (Angkor × 16 instances). 0.5 day.
7. `lava_river_strip` — 1 track (Kilauea). 1 day.

**Hold for hand-modelling**: the Statue of Liberty herself. Block
out a low-poly pass during Phase B; iterate to ship quality during
Sprint 3 (Phase E).

### Phase C — Sprint 1: Reef Cup + tutorial (M13, ~2 weeks)

**Shipped 2026-05-18.** All four seeds materialise their `.blend` +
`.glb` + JSON + hero/thumb JPGs via `pnpm seed:track-<id>`. Headless
build numbers below; each track is now opening-in-Blender-ready for
art tuning.

| Track | Base template | Arc length | Lap target | GLB size |
|---|---|---|---|---|
| Mayday Bay (tutorial) | template-island | ~1530 m | ~61 s | 8.4 MB |
| South Beach Sunken | template-island | ~1191 m | ~48 s | 8.5 MB |
| Hatteras Light | template-island | ~1263 m | ~50 s | 8.5 MB |
| Cape Town Drift | template-island | ~1200 m | ~48 s | 8.6 MB |

Lowest-difficulty tracks first; uses the most mature templates.

| Track | Base template | Key landmarks | Wave zones | VFX emitters | Estimated effort |
|---|---|---|---|---|---|
| Mayday Bay (tutorial) | template-island | none new | 1 (gentle) | palm sway × N | 2 days |
| South Beach Sunken | template-island + drowned_facade (art_deco style) | 3 hotel facade clusters + 1 partial seaplane (small `arch_ruin`) | 2 (lagoon + open bay) | palm sway, gull flock, sun-haze motes | 3 days |
| Hatteras Light | template-island + `tower_cylinder_spiral` (spiral stripe) | 1 lighthouse | 3 (heavier Atlantic chop on one side) | foghorn ambient + rotating beam (anti-grav segment lights it) | 3 days |
| Cape Town Drift | template-mesa (Table Mountain backdrop) + `glass_tank_broken` + leaning `landmark_wheel_ferris` (existing) | aquarium tank, Cape Wheel | 1 (calm harbour) | algae greens, container-rust streaks | 4 days |

**Sprint exit criterion**: Reef Cup playable end-to-end on a fresh
playthrough; track-select tiles light up; one music track per venue
either licensed or proc-bed stand-in.

### Phase D — Sprint 2: Open Sea + Continental (M14, ~3 weeks)

**Shipped 2026-05-18.** All five seeds materialise their `.blend` + `.glb` +
JSON + hero/thumb JPGs via `pnpm seed:track-<id>` and pass `pnpm
gen:tracks:validate` (0 errors each; 4 of 5 carry advisory spline-clip
warnings against downtown-template building footprints, polish item for
post-build art tuning). Hero sprint complete — The Maw + Shibuya are
ready for the trailer; the other three are ready for cup wiring.

| Track | Base template | Arc length | Lap target | GLB size |
|---|---|---|---|---|
| The Maw | template-island (sparse) | ~1465 m | ~58 s | 8.4 MB |
| Shibuya Submerged | template-downtown (tokyo_neon style) | ~1437 m | ~57 s | 2.6 MB |
| Kilauea Crown | template-island + caldera ring | ~1688 m | ~67 s | 8.5 MB |
| Marina Bay 7 | template-downtown (industrial) | ~1411 m | ~56 s | 2.6 MB |
| Doge's Drift | template-downtown (venice) | ~1511 m | ~60 s | 2.5 MB |

The hero sprint. The Maw and Shibuya are the trailer shots.

| Track | Base | Key landmarks | Wave zones | Anti-grav segments | Effort |
|---|---|---|---|---|---|
| The Maw | template-island (sparse) | `arch_ruin` × 3 (one giant) | 4 zones inc. one directional swell at central arch — wave-mastery purest test | none | 4 days (hero polish heavy) |
| Shibuya Submerged | template-downtown (tokyo_neon style) + `tower_cylinder_spiral` (cocoon criss-cross) + `glass_tank_broken` (crossing) | Cocoon Tower face, Skytree silhouette backdrop | 2 (calm rooftop crossings, surge between buildings) | wall-ride strip on Cocoon Tower | 5 days |
| Kilauea Crown | template-island + `lava_river_strip` | caldera ring + lava waterfall | 1 (beach impact) | banked caldera loop (ribbon tool) | 4 days |
| Marina Bay 7 | template-downtown (industrial style) + container stacks + `mechanical_rig` × 5 | gantry cranes (animated), beached tanker | 1 (murky harbour) | none | 4 days |
| Doge's Drift | template-downtown (venice style) + `tower_cylinder_spiral` (Campanile) + `arch_ruin` (Rialto) + `mechanical_rig` (bell) | Campanile, Rialto, lion columns | 1 (Adriatic) | Campanile climb | 5 days |

**Sprint exit criterion**: Open Sea Cup + Continental Cup playable;
trailer footage capturable. ✅ Met — all five tracks open in Blender,
export end-to-end, render hero JPGs, and load without runtime errors.

**Polish pass shipped same day** (post-merge follow-up): per-track sky
preset stamping landed on Shibuya / Marina Bay 7 / Doge's Drift
(matching The Maw + Kilauea), so every Sprint 2 track now exports
with its bespoke `colorGrade` (`tokyo_neon` / `nyc_sunset` /
`venice_warm` / `big_sur_golden` / `kilauea_volcanic`). Lint cleanups:
the obstacle collector now backstops `_largest_terrain_mesh` with a
`terrain*` name match (caught the Marina case where a long road slab
out-sized the actual ground plane), and `_OBSTACLE_NAME_EXCLUDES`
gained `antigrav_` + `_rim` so ridable swept surfaces and ring-shaped
colliders (Kilauea's caldera rim) no longer false-positive. Shibuya,
Marina, Doge's seeds now call `kingtide.shift_spline_off_obstacles`
in their augment pass to auto-nudge any downtown-plinth-clipping
anchors. End state: **all five tracks lint clean (0 errors, 0
warnings)**. Animated gantry-crane runtime + lava emissive shader
remain follow-ups.

### Phase E — Sprint 3: Drowned Cup + finale (M15, ~3 weeks)

**Shipped 2026-05-18.** All three seeds materialise their `.blend` + `.glb`
+ JSON + hero/thumb JPGs via `pnpm seed:track-<id>` and pass
`pnpm gen:tracks:validate` (0 errors / 0 warnings each — cleanest sprint
yet, ahead of Sprint 2's advisory spline-clip warnings on downtown
templates). v1 lineup is now complete — all 11 ship tracks + tutorial
end-to-end.

| Track | Base | Arc length | Lap target | GLB size |
|---|---|---|---|---|
| Aqualand | bespoke (inline bmesh on template-island) | ~637 m | ~22 s × 5 laps | 8.4 MB |
| Angkor Drowned | template-alpine + jungle dressing | ~1541 m | ~62 s | 8.5 MB |
| Liberty Drowned | template-downtown (nyc) + bespoke Liberty | ~1835 m | ~73 s | 2.7 MB |

| Track | Base | Key landmarks | Wave zones | Anti-grav segments | Effort |
|---|---|---|---|---|---|
| Aqualand | bespoke (inline bmesh — pool basin, lazy-river curbs, half-pipe slide, lifeguard towers, concourse) on template-island | wave-pool basin, slides, lifeguard towers | **2 incl. The Tsunami** (`surgePeriodS=30`, `surgeAmplitude=4.0` over the lowest concourse) + lazy-river calm | none (half-pipe stays rideable decoration per brief's "optional" call) | shipped |
| Angkor Drowned | template-alpine + library-linked `tower_cylinder_spiral` (×0.7 scale spire) + `carved_face_block` × 16 + inline jungle hills/courtyard walls/strangler-fig roots | Bayon (16 smiling faces along opening straight, alternating sides), Angkor spire (~42 m), Ta Prohm courtyards | 1 (jungle-interior calm) | spire climb — `PROFILE_TUBE` helix, 8 CPs, 1.25 turns from z=2 → z=45, r=13 m | shipped |
| Liberty Drowned | template-downtown (nyc) + inline-bmesh Liberty silhouette (low-poly 121 v / 156 f — pedestal + body cone + head icosphere + broken torch arm + tablet) + library-linked `drowned_facade_nyc` × 3-5 + `arch_ruin` (sagging Brooklyn Bridge) + 7 inline Manhattan rooftop cuboids | Liberty herself (~70 m total, copper-green oxidation + NYC granite pedestal), broken torch arm forward-collapsed onto pedestal, harbour rooftop scatter | 3 (open Atlantic with `directionDeg=270` westerly swell, sheltered cove, mid-harbour) | torch-arm Möbius `PROFILE_BANKED_STRIP` with linear tilt 0→π + crown interior `PROFILE_TUBE` closed loop r=5 m at z=+52 — both ship; spline-shift wired for downtown-template plinth clearance | shipped |

**Sprint exit criterion**: ✅ Met — v1 lineup playable; Liberty herself's
silhouette reads on the trailer (head + body + broken torch arm + tablet
all visible at race-pace from the harbour approach `camera_hero`).
Polish-pass items deferred to follow-up: Liberty crown rays (skipped per
brief allowance — silhouette already readable without them), high-poly
Liberty sculpt pass, jungle-mote emitter materialised but unverified at
runtime, runtime smoke plume + waterpark-PA samples awaiting licensed
audio drop.

### Phase F — Bikes + UI art (parallel, ~1 week)

**Shipped 2026-05-19** (the 2 variants + thumbnail script). 12
track-hero images already landed alongside Sprints 1–3 via the
existing per-track `camera_hero` + headless render flow.

- **2 new bike variants** ✅. `BIKE_VARIANTS` in
  [src/game/bikes/variants.ts](../src/game/bikes/variants.ts) now
  carries five archetypes — **Scout** (heaviest chassis, mass 210, soft
  hover spring 24, lowest surfaceFollow 0.66 → "late-but-biggest
  launch") and **Sparrow** (lightest chassis, mass 115, stiffest spring
  37, highest surfaceFollow 1.05 → "most-forgiving pump") alongside the
  existing Cruiser / Racer / Stunt trio. The five are one balanced class
  of peers (no weight-tier) — rebalanced 2026-06-10 so none is a strict
  upgrade. Scout's GLB shipped earlier; Sparrow seeds from
  `racer.glb` until a dedicated Blender source lands (the runtime
  livery tint in [src/engine/render/render-systems.ts](../src/engine/render/render-systems.ts)
  recolors at clone time so the visual still reads distinct).
  Bike-select picker dropped both "Coming Soon" placeholders.
- **5 bike-select thumbnails** ✅. New `pnpm gen:bike-thumbs`
  ([tools/gen-bike-thumbs.mjs](../tools/gen-bike-thumbs.mjs))
  drives a `BIKE_THUMBS=1`-gated Playwright spec
  ([tests/e2e/gen-bike-thumbnails.spec.ts](../tests/e2e/gen-bike-thumbnails.spec.ts))
  that hits `?viewer=<id>&thumb=1` and writes
  `public/assets/bikes/<id>-thumb.jpg` (480×270, q85) for every
  variant. A new `thumbMode` branch in
  [src/viewer/bike-viewer.ts](../src/viewer/bike-viewer.ts)
  suppresses the reference grid + HUD chrome, tightens the camera
  (1.9, 1.05, 1.9 looking at 0, 0.55, 0 — chassis fills ~70% of the
  tile), and sets `document.body.dataset.bikeViewerReady = '1'` on
  the second rendered frame so the spec has a deterministic
  capture gate.
- **12 track-hero images** ✅ — landed alongside the per-sprint
  track seeds via the addon's `render_track_hero` operator. See
  `public/assets/tracks/<id>-hero.jpg` (1280×720) +
  `<id>-thumb.jpg` (320×180) for each of the 12 v1 tracks.

### Phase G — Audio (parallel with all sprints)

- **Music** is the only unambiguously non-procedural budget item.
  Per the audio palette notes in [track-themes.md](./track-themes.md),
  licence/commission per track as the matching art lands. Procedural
  bed stays as fallback so playtest never plays in silence.
- **Ambient beds**: 12 layered loops authored against the schema from
  gap 10. ~1 day per track to mix; ~12 days total but parallelisable
  with the track sprint.
- **UI / race / pickup SFX**: one polish week somewhere in Phase E.

---

## Definition of done — per track

Adapted from the work-breakdown's three-checks convention. A v1 track
is "done" when:

1. **Layout** clears the addon's lint pass (no spline/start
   pathology, lap length ≥ 60 m, no underwater racing line).
2. **Hero set-piece** is in-place, silhouette-readable at 40 m/s
   from the starting grid.
3. **Wave zones** authored — at least one — and AI pumps where they
   should (verify on Hard difficulty for ≥ one full lap).
4. **Anti-grav segments** (if track-themes calls for them) authored
   via the ribbon tool, controller flips, camera follows.
5. **Sky/grade preset** matches the palette notes in
   [track-themes.md](./track-themes.md) on the hero camera frame.
6. **VFX emitters** placed for the named set-piece beats.
7. **Audio palette** wired — ambient bed + music slot referenced,
   even if music is the procedural stand-in.
8. **Track-hero image** generated via the headless render.
9. **AI line** completes a clean lap on all three difficulties.
10. **Track-select tile** activates (no longer `bc-disabled`).

---

## Estimated total

| Phase | Effort |
|---|---|
| A: Pipeline foundation | 1.5 weeks |
| B: Hero-landmark library | 1.5 weeks |
| C: Sprint 1 (Reef) | 2 weeks |
| D: Sprint 2 (Open Sea + Continental) | 3 weeks |
| E: Sprint 3 (Drowned + finale) | 3 weeks |
| F: Bikes + UI art | 1 week |
| G: Audio (parallel) | n/a (overlapping) |

**Total** ~12 weeks of focused single-author work, which aligns
roughly with M13–M15 in [implementation-plan.md](./implementation-plan.md).

The realistic schedule shifts if Liberty's hand-modelling stretches
or if music licensing slips — those are the two non-procedural risks
in the otherwise procedural-first plan.

---

## References

- [v1-work-breakdown.md](./v1-work-breakdown.md) — *what* / *why*.
- [track-themes.md](./track-themes.md) — content bible per track.
- [design-targets.md](./design-targets.md) — numeric targets.
- [blender-pipeline-guide.md](./blender-pipeline-guide.md) — current
  authoring stack.
- [blender-wishlist.md](./blender-wishlist.md) — open automation
  items (some of which become gaps 1, 5 above).
- [asset-pipeline-guide.md](./asset-pipeline-guide.md) — spec → GLB
  pipeline.
- [vertex-attribute-spec.md](./vertex-attribute-spec.md) — `COLOR_0`
  contract.
