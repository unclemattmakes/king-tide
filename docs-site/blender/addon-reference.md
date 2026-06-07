# Addon reference

Comprehensive reference for the in-Blender addon — every panel, every
operator, and the headless builders that mirror them. For a guided
walk-through that uses these tools end-to-end, see
[Your first track](./your-first-track). For worked examples of two
of the more involved subsystems, see the
[Wave zones cookbook](./wave-zones).

## Top-level panel

Press **N** in the 3D viewport → switch to the **Hoverbike** tab.
The panel re-renders based on the `.blend`'s parent directory:

| Parent dir | Mode | Header buttons |
|---|---|---|
| `tracks-src/<id>.blend` | Track | **Export Track to Game**, Lint, Reload from JSON, Re-tag Scene, Play / Edit, Copy Play / Edit URL |
| `bikes-src/<id>.blend` | Bike | **Export Bike to Game**, Copy Play / Viewer URL |
| anything else | Unknown | Help text — save your .blend somewhere recognised |

Inside track mode you get 18 sub-panels covering every authoring
tool. Most sub-panels are **selection-driven** — they only render
when an object of the matching kind is the active object. The
**Hoverbike** top-bar menu (always visible) and the `Shift+H` pie
menu spawn objects from a flat menu so the matching sub-panel can
then appear in the sidebar.

Bike mode is intentionally minimal — the .blend is the source of
truth; the export is one click.

---

## Track sub-panels

### Spline tools

Operates on `ai_spline_main` — the canonical racing line.

| Operator | What it does | Notes |
|---|---|---|
| **Snap Spline to Terrain** | Raycasts each control point straight down onto the scene, then lifts each hit by **Hover (m)**. | Hides preview gizmos during the cast so they can't catch the ray. Hides `road_main` too so the spline lands on terrain, not the road slab. Water counts as drivable. |
| **Cursor → Spline** | Moves the 3D cursor to a parameter `t` ∈ [0,1] along the racing line, with rotation aligned to the tangent. | Useful before dropping a ramp / boost pad / prop so it inherits the racing-line orientation. |
| **Snap Starts to Spline** | Repositions `start_00` / `start_01` on the racing line, perpendicular to the tangent, at **Start gap** apart. | The grid pattern for AI bikes spawns relative to `start_00` (see `specs/grid-offsets.json`). |
| **Add Ramp at Spline t** | Snaps the cursor (using *t*), then drops a ramp. One-click. | Uses the current ramp dimensions from the Ramps sub-panel. |
| **Auto-place Ramps** | Drops tangent-aligned ramps at every curvature peak above **\|κ\|**, respecting **Spacing**. | Same curvature detector that powers the turn-indicator preview. |

Scene properties live here: `hoverbike_snap_hover_height`,
`hoverbike_placement_t`, `hoverbike_start_grid_spacing`,
`hoverbike_auto_ramp_kappa`, `hoverbike_auto_ramp_min_spacing`.

### Placement helper

A persistent, curve-constrained empty named `placement_helper`.
Park it at any (`t`, lateral offset) and use it as a placement
anchor.

| Operator | What it does |
|---|---|
| **Add Placement Helper** | Spawns the singleton (or re-poses it to the current `t` / offset). |
| **Remove Placement Helper** | Deletes the helper. |
| **Cursor → Helper** | Snaps the 3D cursor to the helper's transform. |
| **Add Ramp at Helper** | Drops a ramp at the helper's pose. |
| **Add Boost Pad at Helper** | Drops a boost pad at the helper's pose. |

Scene properties: `hoverbike_helper_t` (0..1),
`hoverbike_helper_offset` (-200..+200 m, perpendicular to the
tangent; positive = right).

Sliders re-pose live via the addon's debounce timer — scrubbing is
interactive, not click-to-apply.

### Road tool

Bezier curve → drivable road slab with terrain conform + F1 curbs.

| Operator | What it does |
|---|---|
| **Add Road Curve** | Drops `road_curve_main`, a 4-point Bezier near the scene origin. Tab into edit mode to shape it. |
| **Build Road** | Samples the curve, conforms the terrain to its altitude in a `width/2 + curb_width + blend_radius` band, emits the road mesh tagged `kind=track`. |

Scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_road_width` | 8 m | Total road surface width. |
| `hoverbike_road_lift` | 0.15 m | Z offset so the road reads above terrain. |
| `hoverbike_road_thickness` | 0.6 m | Extrusion depth. 0 = paper-thin ribbon; any positive value gives a volumetric slab. |
| `hoverbike_road_blend_radius` | 6 m | Outer falloff band; terrain smoothsteps back to natural beyond. |
| `hoverbike_road_samples` | 64 | Arc-length sample count. |
| `hoverbike_road_smooth_passes` | 4 | 1-2-1 binomial smoothing on the height profile. |
| `hoverbike_road_bank_strength` | 0.6 | Multiplier on curvature-driven auto-bank. 0 disables. |
| `hoverbike_road_bank_max_deg` | 25° | Hard cap on signed bank angle. |
| `hoverbike_road_curb_width` | 0.6 m | F1 curb width. 0 disables curbs. |
| `hoverbike_road_curb_height` | 0.12 m | Curb rise. |
| `hoverbike_road_curb_stripe_length` | 2 m | Length of each red / white stripe. |

Per-control-point banking: edit a Bezier point's **Tilt** in the
N-panel → Curve → Tilt; that value adds on top of the auto-bank.

Materials emitted: `mat_track_road` (asphalt), `mat_track_curb_white`,
`mat_track_curb_red`, `mat_track_road_underside`.

::: warning Active terrain modifiers
If the terrain has active modifiers (e.g. `HV_Island` GN graph),
the operator errors out — GN displacement stacks on top of the
road's vertex edits and spikes the terrain. Toggle **Apply
modifiers first** in the Build Road redo panel to bake the
modifier in. One-way; save first.
:::

### Tunnels

Bezier curve → boolean cut through any terrain mesh + a concrete
liner interior shell.

| Operator | What it does |
|---|---|
| **Add Tunnel Starter Curve** | Drops `tunnel_curve_main` near the scene origin. |
| **Build Tunnel** | Samples the curve, emits a closed-manifold cutter cylinder + an inward-facing interior shell, ensures the terrain has a Boolean DIFFERENCE modifier targeting the cutters collection. |

Scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_tunnel_radius` | 8 m | Interior radius. 16 m diameter is arcade-sized. |
| `hoverbike_tunnel_wall_thickness` | 1 m | Extra radius on the cutter beyond the interior — the apparent concrete thickness at the mouth. |
| `hoverbike_tunnel_samples` | 32 | Arc-length subdivisions of the curve. |
| `hoverbike_tunnel_segments` | 14 | Radial segments per ring. |
| `hoverbike_tunnel_end_extend` | 4 m | Distance the cutter pushes past the curve endpoints. Ensures the cap clears the hillside surface. |

The terrain carries a single Boolean DIFFERENCE modifier named
`HV_Tunnel_Cut` whose operand is the `_hoverbike_tunnel_cutters`
collection (hidden in viewport + render). A second tunnel just
drops another cutter in — the existing modifier picks it up.
`export_apply=True` on the GLB exporter bakes the cut.

Re-builds pick the next free `tunnel_NN` slot. To author multiple
tunnels, rename `tunnel_curve_main` between builds.

::: tip Canonical reference: `tracks-src/template-tunnels.blend`
A hand-curve-driven seed file with three mountains, one tunnel
through each, and an AI-completable racing line threading them all.
The seed script is `tools/blender/seed_template_tunnels.py`. The
addon's tunnel tool is now marked deprecated — the seed file is the
canonical implementation.
:::

### Anti-grav surfaces

> **Parked — anti-grav is cut** (parked for a possible DLC). These operators
> still ship in the addon, but no shipped track places anti-grav zones; don't
> author anti-grav into a v2 track. Documented here for completeness.

Sweep a cross-section profile along a Bezier curve to produce a
drivable corkscrew tube, wall-ride ribbon, or banked / wall /
ceiling strip — and auto-drop the entry / exit anti-grav zone
empties that flip the bike's gravity at the boundaries.

| Operator | What it does |
|---|---|
| **Add Anti-Grav Curve** | Drops a fresh `antigrav_curve_NN` Bezier (4 control points) at the 3D cursor. `AuthoringKind.ANTIGRAV_CURVE` — never exported, viewport-only. |
| **Build Anti-Grav Surface** | Reads the active curve + the current profile knobs and emits the swept mesh + two oriented `antigrav_NN_zone_entry` / `_zone_exit` empties at the curve endpoints. Uses a parallel-transport frame so the cross-section doesn't flip mid-corkscrew. Re-clicking the operator on the same curve rebuilds in place. |

Profile selector + scene properties:

| Property | Default | Notes |
|---|---|---|
| `hoverbike_antigrav_profile` | `TUBE` | One of `TUBE`, `RIBBON`, `BANKED_STRIP`. |
| `hoverbike_antigrav_radius` | 8 m | TUBE only — interior radius (matches the tunnel default). |
| `hoverbike_antigrav_segments` | 14 | TUBE only — radial segment count. |
| `hoverbike_antigrav_width` | 6 m | RIBBON / BANKED_STRIP — strip width. |
| `hoverbike_antigrav_thickness` | 0.4 m | RIBBON / BANKED_STRIP — slab thickness. |
| `hoverbike_antigrav_samples` | 48 | Arc-length subdivisions of the curve. Bump for long corkscrews. |

The three profiles:

- **Tube** — closed cylinder along the curve. Corkscrews climbing a
  pillar, caldera loops, anything fully enclosed.
- **Ribbon** — flat strip (`width × thickness`). Wall-rides, the
  Liberty torch underside, half-pipe lips. Geometry-only — rotate
  the curve to stand the ribbon up (wall) or hang it upside-down
  (ceiling).
- **Banked strip** — slab whose per-sample tilt comes from each
  control point's **Tilt** field. Tilt = ±π/2 for a wall, ±π for a
  ceiling, anything between for a banked corner. Same N-panel →
  Item → Tilt slider as the road tool, plus the **Anti-Grav
  presets** row in the Gameplay sub-panel (Flat / Bank L / Wall R /
  Ceiling) for one-click set.

Each Build emits:

- `antigrav_NN_surface` — the swept mesh, `kind=track` + `anti_grav=true`
  extras so the runtime trimesh collider attaches.
- `antigrav_NN_zone_entry` and `antigrav_NN_zone_exit` — oriented
  box empties, `kind=antigrav_zone`, local +Y pointing along the
  curve tangent so the bike enters the volume on approach. The
  existing anti-grav controller (`antigrav.py` + the runtime
  controller) handles the actual gravity flip when a bike crosses
  the zone.

::: tip Reference scene: `tracks-src/template-antigrav-showcase.blend`
A working example of all three profiles together — one tube
corkscrew climbing a pillar, one ribbon wall-ride, one banked-strip
loop. Open it with **Hoverbike → Utility → New Map from Template**
to start a new track from this base.
:::

### Ramps

Drop a parametric stunt-ramp wedge at the 3D cursor.

| Operator | What it does |
|---|---|
| **Add Ramp** | Drops a `ramp_NN` empty + child mesh at the 3D cursor, tagged `kind=track` with `mat_track_ramp`. |

Scene properties: `hoverbike_ramp_length`, `hoverbike_ramp_width`,
`hoverbike_ramp_height` — used at placement time.

The mesh is driven by a Geometry Nodes modifier (`HV_Ramp`); to
resize an existing ramp, open its modifier and edit Length / Width
/ Height live. The wedge has a 30 cm foundation depth so it's
always a closed solid (no degenerate top/bottom coplanar quads).

### Terrain

Heightmap import, sculpt entry, raise / lower / smooth, AO + path
bakes.

| Operator | What it does |
|---|---|
| **Import Heightmap** | Reads a greyscale PNG/EXR and emits `terrain_heightmap`, a subdivided plane whose verts are luminance-displaced. Tagged `kind=track`. Re-import is idempotent. |
| **Apply Terrain Modifiers** | Bakes every viewport-enabled modifier on the terrain into vertex data. One-way: parametric tunability of GN sliders is lost. Save first. |
| **Subdivide Terrain** | One cut per click (each face → 4) when the procedural mesh is too coarse. |
| **Sculpt Terrain** | Selects the terrain and enters Sculpt Mode. Standard Blender brushes apply once the modifier stack is empty. |
| **Raise / Lower @ cursor** | Bulk-shape with a smoothstep falloff from the 3D cursor. Faster than brushes for large hills. |
| **Smooth Terrain** | Laplacian-Z pass over every vertex. XY positions stay locked so the heightfield stays a heightfield. |
| **Bake AO + Path Wear** | Cycles vertex-colour bake (~10-20 s on a 150 k-vert terrain) plus the path-wear pass. Fills `baked_ao` (G channel) and `baked_path` (B channel) into the active vertex-colour layer. |
| **Bake Path-Worn** | Just the racing-line mask. Pure-Python KDTree (~1 s on a 150 k-vert terrain); cheap to re-run while iterating on `Inner` / `Outer` / `Intensity`. |

Path-wear knobs (set on the Terrain sub-panel; export auto-bakes
before writing the GLB so authors who never touched these still
ship with a baked racing line):

| Property | Default | Notes |
|---|---|---|
| `hoverbike_path_inner_m` | 0 m | Distance from the spline at which wear saturates at 1.0. |
| `hoverbike_path_outer_m` | 8 m | Distance beyond which wear is 0. Smoothstep falloff between. |
| `hoverbike_path_intensity` | 1.0 | Final-value multiplier in [0, 1]. 0 disables the stamp. |

Heightmap import knobs: `hoverbike_heightmap_size`,
`hoverbike_heightmap_subdivisions`, `hoverbike_heightmap_height`,
`hoverbike_heightmap_base`, `hoverbike_heightmap_path`.

Sculpt + raise/lower knobs: `hoverbike_sculpt_radius`,
`hoverbike_sculpt_magnitude`, `hoverbike_sculpt_smooth_iters`,
`hoverbike_sculpt_smooth_weight`.

### Water

Sea level + Gerstner wave preview.

| Operator | What it does |
|---|---|
| **Add Water Volume** | Creates `water_volume_main` (cube empty) with `kind=water`, `wave_height=0.6`, `wave_freq=0.5` extras. Spawns the wave preview plane. |
| **Rebuild Water Preview** | Rebuilds the wave-displaced preview plane around the volume. |
| **Hide Water Preview** | Toggles the preview collection's visibility off without deleting. |

Scene properties: `hoverbike_water_height` (proxies `water_volume_main.location.z`),
`hoverbike_water_size`, `hoverbike_water_subdivisions`,
`hoverbike_water_time`.

The volume's Z position is the in-game sea level — round-trips
through `water.height` in the JSON on export.

For zone-local wave amplification (tsunami timers, harbour calm,
big set-piece swells) see the [Wave zones](#wave-zones) sub-panel
and the dedicated [Wave zones cookbook](./wave-zones).

### Horizon

Per-track distant silhouette mesh — the camera-locked cylinder of
"distant mountains" that gives the far field a tangible shape
instead of an empty fog gradient.

Tracks without an authored horizon mesh fall back to a procedural
seeded ring (five-octave layered sine, 192 segments, seed hashed
from the track id). The fallback's `radius` / `peakHeight` /
`seed` / `silhouetteDark` are still tunable from this sub-panel —
they round-trip through `public/tracks/<id>.json`'s `horizon` block.

| Operator | What it does |
|---|---|
| **Add Horizon Ring** | Drops `horizon_ring` (mesh, `kind=horizon`, 192 × 2 verts) at origin using the same layered-sine starter the runtime uses. Knobs above the button choose Segments / Radius / Peak / Seed *before* you commit. |
| **Edit Horizon Ring** | Selects the mesh and enters edit mode. Turn on Proportional Editing (`O`) and pull verts into your track's recognisable skyline — Skytree behind Shibuya, Table Mountain behind Cape Town. |
| **Reset Horizon Ring** | Destructive re-seed of the starter. Loses your edits in exchange for a fresh procedural layout. Use when you want a different seed. |
| **Delete Horizon Ring** | Removes the authored mesh; the track falls back to the procedural fallback on the next export. |

Runtime precedence on load:

1. `kind=horizon` mesh in `environmentGlb` (Blender-authored — wins)
2. `horizon` block in `public/tracks/<id>.json` (procedural with overrides)
3. Default procedural with seed hashed from the track id.

The mesh exports as part of the normal track GLB. The GLB loader's
first pass extracts every `kind=horizon` node before terrain shading
or collider attach, so the ring costs the same single draw call
regardless of whether it's procedural or authored.

### Sky preset

Per-track sky / atmosphere block in `public/tracks/<id>.json` that
the runtime applies once at boot. All fields are optional —
absent fields fall back to the defaults baked into `sky.ts`.
Default-closed sub-panel (lives between **Horizon** and **Wave zones**).

| Knob | Meaning | Runtime impact |
|---|---|---|
| `tint` | Hex colour multiplied onto the dome palette. White = no tint. | Live — biases palette warm / cool without rewriting ramps. |
| `cloudiness` | 0..1 cloud-layer density. | Live — drives the FBM cloud mask threshold. |
| `sunIntensity` | Multiplier on the directional sun + sun-disc. | Live — scales `DirectionalLight.intensity` and shader sun disc. |
| `fogNear` / `fogFar` | Exponential fog distances (m). | Live — the horizon ring sits ~75 % through this range. |
| `timeOfDay` | 0..360 s along the (frozen) day-night cycle. | Live — picks elevation + azimuth at construction; held for the race. |
| `colorGrade` | LUT preset name from the bundled set. | Live — per-preset (tint × saturation × contrast) tweak on the dome. |
| `bloom` | 0..2 intensity multiplier on the renderer bloom pass. | **Round-trip only** — no bloom pass is wired into the WebGPU renderer yet. Goes live when the post pipeline lands. |
| `seaStateBeaufort` | 0..12 Beaufort wind scale. | Live — scales every base wave amplitude at boot (Beaufort 4 ≈ 1.0×, glass-calm 0 ≈ 0.15×, hurricane 12 ≈ 2.5×). Wave zones layer on top via `heightMult`. |

Bundled `colorGrade` presets (each a (tint × saturation × contrast)
triple in `SKY_GRADE_TABLE` in `sky.ts`):

| Preset | Look |
|---|---|
| `neutral` | No grade — identity. |
| `miami_pastel` | Soft warm-pink lift, lower saturation; South Beach sunset. |
| `tokyo_neon` | Cool magenta-cyan lean, punchy saturation; Shibuya night. |
| `big_sur_golden` | Golden-hour warmth; California / The Maw mid-day. |
| `venice_warm` | Adriatic warm-stone amber; Doge's Drift. |
| `nyc_sunset` | Strong warm tint, high contrast; Liberty finale. |
| `cape_town_blue` | Atlantic cool blue, desaturated haze. |
| `kilauea_volcanic` | Ash + lava red lift, high contrast. |

The preset list is mirrored in two files: `SKY_COLOR_GRADES` in
`src/game/tracks/types.ts` (with its lookup table in `sky.ts`) on
the runtime side, and `SKY_COLOR_GRADES` in
`tools/blender/hoverbike_addon/sky_preset.py` on the addon side.
Adding a preset means editing both — there's no auto-sync yet.

**Round-trip.** The sky block is fully Blender-owned: any value the
.blend dialled in wins over what's in the JSON on next export. The
`load_post` handler in `handlers.py` pulls the JSON back into the
scene props on `.blend` open, so opening a track always reflects
the most recently saved values.

### Wave zones

Author wave zones as `wave_zone_NN` empties — the wave-mastery
analogue of `antigrav_NN` anti-grav zones. Each zone multiplies the
global Gerstner wave amplitude / frequency inside its oriented
bounding box, with optional periodic surge for tsunami timers and
an optional dominant-swell direction override. The runtime
evaluates zones via `sampleZoneFactors` in
`src/engine/sim/water/wave-field.ts`.

| Operator | What it does |
|---|---|
| **Add Wave Zone** | Drops a `wave_zone_NN` empty at the 3D cursor. Cube display, default extents 60 m × 60 m × 40 m, `height_mult=1.5`, `freq_mult=1.0`, `blend_radius_m=20`. A translucent cyan box gizmo parents to the empty so the volume + swell direction read at a glance. |
| **Refresh Wave Zone Visuals** | Rebuilds every `wave_zone_NN` gizmo to match its current half-extents. Use after editing `half_*` custom props directly in the Properties panel — slider edits in the addon auto-refresh, but direct-property edits don't. |

The empty's **local +X axis is the dominant swell direction**.
Rotate around Z to aim the swell; edit half-extents to grow /
shrink the volume.

Custom properties on each empty (defaults in parentheses):

| Property | Default | Notes |
|---|---|---|
| `half_width` | 30 m | Half-extent along local +X (the swell axis). |
| `half_height` | 20 m | Half-extent along local +Z (vertical). Mostly cosmetic — surface samples ignore the vertical extent. |
| `half_depth` | 30 m | Half-extent along local +Y. |
| `height_mult` | 1.5 | Multiplier on global wave amplitude. 1 = neutral, >1 = bigger waves, <1 = calmer. |
| `freq_mult` | 1.0 | Multiplier on per-wave frequency (= 1/wavelength). 1 = neutral, >1 = choppier / shorter wavelengths. |
| `blend_radius_m` | 20 m | Soft-edge falloff outside the OBB face. Keeps the boundary invisible. |

Optional extras — add these as Custom Properties on the empty when
the zone needs them:

| Property | Notes |
|---|---|
| `direction_deg` | Override the dominant swell bearing, degrees in world XZ. 0° = +X swell train, 90° = +Z. Leave unset to inherit the global wave bearing. |
| `surge_period_s` | Period of the additive surge term, in seconds. |
| `surge_amplitude` | Amplitude of the additive surge term, in metres. **Both `surge_*` fields must be set together** — half a surge spec is rejected by the JSON validator. |

Multi-zone overlap rule: soft-max on the multipliers (the
strongest-weighted zone wins on amplitude / frequency / bearing,
which matches author intent — "inside The Maw's central-arch zone
I expect the central-arch swell"). Surges accumulate (overlapping
tsunami sources sum, which reads as intuitive — "two tsunamis
meeting → bigger wave").

Wave zones round-trip through `waveZones[]` in the JSON. Like
boost pads, the merge is opt-in: if the `.blend` has any
`wave_zone_NN` empties, Blender owns the list; otherwise the
in-app editor's placements stay through re-exports.

For end-to-end worked examples (Aqualand tsunami timer, harbour
calm, set-piece swell aimed at a turn, choppy-vs-rolling) see the
[Wave zones cookbook](./wave-zones).

### Gameplay

Gates, boost pads, anti-grav zones, racer preview, turn indicators
— the high-level "what does the player interact with" placement
section.

| Operator | What it does |
|---|---|
| **Rebuild Gate Preview** | Instances the real `prop_gate_mesh` (linked from `tracks-src/props-library.blend`) every `gateSpacing` metres along `ai_spline_main`. Falls back to a wireframe rectangle if the library is missing. |
| **Hide Gate Preview** | Toggles the gate preview off without deleting. |
| **Materialise to cp_NN** | Pin the current spline-derived gate positions to `cp_NN` empties so individual gates can be hand-tweaked. |
| **Re-stamp from Spline** | Re-stamp existing `cp_NN` empties from the current spline (when you've moved the spline and want to refresh hand-placed gates). |
| **Demote to Spline (wipe cp_NN)** | Delete every `cp_NN` empty and return to pure spline-driven gates. |
| **Add Boost Pad** | Drops a `boost_NN` empty at the 3D cursor. The empty's local +Y axis is the boost direction. |
| **Refresh Boost Pads** | Rebuilds the cyan-emissive slab gizmos under every `boost_NN` empty. |
| **+ Anti-Grav Zone** | Drops an `antigrav_NN` empty at the 3D cursor — a free-standing anti-grav volume not bound to a curve. Used for off-route stretches and entry / exit pads that don't need a swept surface. |
| **Refresh Anti-Grav Zones** | Rebuilds the gizmos so the box visual tracks each zone's half-extent props. |
| **Toggle Spline Anti-Grav** | Flips `anti_grav=true/false` on `ai_spline_main` — when ON, the runtime auto-builds an anti-grav corridor along the racing line driven by per-anchor tilt. |
| **Anti-Grav presets** (Flat / Bank L / Bank R / Wall L / Wall R / Ceiling) | One-click set the active spline anchor's Tilt to 0 / ±π/4 / ±π/2 / π. Only renders while in EDIT_CURVE mode on `ai_spline_main`. |
| **Rebuild Racer Preview** | Drops a bike silhouette at `start_00` plus one per AI slot from `specs/grid-offsets.json`. |
| **Hide Racer Preview** | Toggles the racer preview off. |
| **Rebuild Turn Indicators** | Drops chevron gizmos at every curvature peak above `\|κ\|`. |
| **Hide Turn Indicators** | Toggles the indicators off. |

Scene properties: `hoverbike_gate_spacing`, `hoverbike_gate_half_width`,
`hoverbike_gate_height`, `hoverbike_turn_kappa`,
`hoverbike_turn_min_spacing`.

Boost pad custom properties (defaults match the in-app editor):

| Property | Default | Notes |
|---|---|---|
| `half_width` | 3 m | Extent across the pad. |
| `half_depth` | 6 m | Extent along the boost direction. |
| `strength` | 1.5 | Top-speed multiplier on overlap. |

Anti-grav zone custom properties:

| Property | Default | Notes |
|---|---|---|
| `half_width` | 30 m | Half-extent along the box's local X axis. |
| `half_height` | 8 m | Half-extent along the box's local Y axis — the vertical clearance the bike can have above / below the road plane and still count as "in zone". |
| `half_depth` | 30 m | Half-extent along the box's local Z axis. |

Author rotation so the box's local floor lies flat on the road
surface — on a flat road no rotation is needed; on a banked corner
yaw to follow the road and roll / pitch so local +Y matches the
road normal. The runtime applies a PD-aligned torque so the bike's
own +Y rotates onto the zone's up.

Gate / racer / turn previews live in render-disabled
`_hoverbike_*_preview` collections; they never reach the GLB.

### Emitters

A unified emitter abstraction drives every authored track VFX —
wave-pump flash, lava steam, neon glare, gull flocks, palm sway,
torch flame, oxidation shimmer, jungle motes, container rust,
tsunami spray, anything else. The runtime
(`createParticleSystem` in `src/engine/render/particle-system.ts`)
reads `kind=emitter` empties from the loaded GLB and spawns
particles from their pose using a shared 1024×1024 atlas split
into a 4×4 grid of 16 cells.

| Operator | What it does |
|---|---|
| **Add Emitter** | Drops an `emitter_NN` empty (SPHERE display) at the 3D cursor with default extras. Local +Y is the emission direction. |

Custom properties on each empty:

| Extra | Default | Meaning |
|---|---|---|
| `atlas_cell` | 0 | 0..15 — picks a 256×256 sprite from the shared atlas. |
| `emit_rate` | 30 | Particles spawned per second. |
| `lifetime_s` | 1.5 | Seconds before a particle is recycled. |
| `velocity_cone_deg` | 25 | Half-angle of the emission cone around local +Y. |
| `speed_min` / `speed_max` | 0.8 / 2.5 | Uniform-random initial speed (m/s). |
| `size_start` / `size_end` | 0.4 / 1.2 | World-space sprite size, lerped over age. |
| `color_start` / `color_end` | white → white(alpha 0) | RGBA, lerped over age. |
| `gravity` | 0 | Y-axis acceleration (m/s²). 0 = drift, negative = fall, positive = rise. |
| `max_particles` | 256 | Per-emitter cap contributed to the cell pool. |

Atlas cell legend (mirrored in `build_sprite_atlas.py`):

| Cell | Sprite | Typical use |
|---|---|---|
| 0 | soft round spark | wave-pump flash, generic shine |
| 1 | smoke puff | lava steam, container fire, exhaust haze |
| 2 | ember | torch flame, hot debris |
| 3 | foam droplet | water spray, tsunami crests |
| 4 | dust mote | jungle motes, ash drift, sun-haze |
| 5 | gull silhouette | gull flocks |
| 6 | leaf | palm sway debris, jungle floor swirl |
| 7 | neon glare | Shibuya neon, lighthouse beam |
| 8 | ash | Kilauea ashfall |
| 9 | water spray | breaking wave plumes |
| 10 | glow halo | bell ripple, oxidation shimmer |
| 11 | motion streak | speed lines |
| 12-15 | spare | aliased to 0/1/2/3; safe to override later |

Regenerate the atlas with `pnpm gen:fx-atlas` (calls
`python tools/blender/build_sprite_atlas.py`). Pillow is the only
dependency. Output: `public/assets/fx/particle-atlas.png`.

Cost: one `SpriteNodeMaterial` + `InstancedMesh` per **cell** (not
per emitter), so two `dust_mote` emitters on the same track share a
draw call. The system caps at 16 cells × `max_particles` particles,
typically well under 2000 alive at peak.

**Runtime trigger hook.** Gameplay code can fire one-off bursts via
`window.__particles.triggerBurst('emitter_name', count)`. The
`fx/index.ts` explosion path already does this — name an emitter
`emitter_explosion` in the track and every detonation triggers a
24-particle burst from that pose (lava chunks for Kilauea, glass
for Cape Town aquarium, etc).

### Ghost lap + chase cam

| Operator | What it does |
|---|---|
| **Rebuild Ghost Lap** | Binds a bike silhouette to `ai_spline_main` via Follow Path. Attaches a chase camera with Track-To. Sets the scene's frame range to one full lap at **Speed (m/s)**. |
| **Hide Ghost Lap** | Toggles the ghost-lap preview off. |

Scene properties: `hoverbike_ghost_speed`, `hoverbike_ghost_fps`.

After **Rebuild Ghost Lap**, hit `Spacebar` in the viewport to play
back — the chase cam becomes the scene's active camera so
view-from-camera frames the bike.

### Terrain shader (runtime)

Tunes the runtime terrain shader's ramp / slope / wet-band /
coloration knobs. These mirror constants in
`src/engine/render/terrain-shader.ts` and round-trip through
`terrainShader` in the track JSON.

Scene properties (all `hoverbike_shader_*`):

| Property | Range | Notes |
|---|---|---|
| `alt_min` / `alt_max` | -500..500 m | World-Y mapped to ramp 0 / 1. |
| `slope_start` / `slope_end` | 0..1 (cos θ) | Below `slope_start` reads as flat; above `slope_end` reads as cliff. 0.85 ≈ 30°; 0.55 ≈ 55°. |
| `variation` | 0..1 | ±brightness perturbation from per-vertex noise. |
| `wet_band` | 0..20 m | Half-height of the \|y\|-mask around the waterline. |
| `path_tint_r/g/b` | 0..2 each | Tint multiplied through the path-worn vertex channel. |
| `warp_strength` | 0..4 | Low-freq noise that warps the colour-noise UVs. |
| `macro_scale` / `micro_scale` | 10..1000 / 0.5..40 m | World-space scales for macro / micro detail. |
| `alt_jitter` | 0..30 m | Vertical jitter so contour lines aren't perfectly level. |
| `scree_band` | 0..1 | Width of the intermediate gravel band between flat and cliff. |
| `saturation` | 0..2 | Output saturation multiplier. |
| `triplanar` | 0..1 | Blend factor between top-down and triplanar sampling on cliffs. |

Default-closed sub-panel — usually set once per track.

### Track hero render

Camera-driven loading-screen art. The render is reproducible, fast
(sub-second EEVEE renders are typical on a modern GPU), and
auto-fires on every track export so the UI art never drifts from
the latest `.blend`.

| Operator | What it does |
|---|---|
| **Add Camera Hero** | Drops a Camera object named `camera_hero` (`AuthoringKind.CAMERA_HERO`) at the 3D cursor with a 50 mm lens, aimed at a sensible default target (`start_00`, the AI-spline mid-point, or world origin). Translate / rotate to frame the track's set-piece. |
| **Render Hero** | Renders the full 1280×720 hero + the 320×180 tile in one shot. Forces EEVEE for speed. Lands in `public/assets/tracks/<id>-hero.jpg` / `-thumb.jpg`. |
| **Render Tile Only** | Refreshes just the smaller image after a framing tweak. |

The track's `manifest.json` entry gains a `heroUrl` field (and a
`thumbUrl` field if the tile was rendered too) pointing at the
public URL.

**Automatic on export.** *Export Track to Game* fires the hero
render automatically after the GLB write succeeds. If `camera_hero`
is missing, the export warns and continues — the hero render is
non-fatal so a mid-authoring `.blend` without a hero still exports
successfully.

**Batch / CI render.** The standalone script
`tools/blender/render_track_thumbnail.py` runs the same render
headlessly without going through the addon UI — useful for CI batch
builds that need to refresh every track's hero in one pass:

```bash
"$BLENDER_EXE" --background tracks-src/<id>.blend \
    --python tools/blender/render_track_thumbnail.py
```

Exits non-zero if the `.blend` lacks a `camera_hero` or the repo
root can't be resolved.

**Runtime story.** The runtime never sees the camera — the GLB
exporter is invoked with `export_cameras=False`, so `camera_hero`
(and any other Camera object) is stripped before the GLB lands in
`public/assets/tracks/`. The chase cam is procedural; the hero
camera is an authoring-only `AuthoringKind` whose only job is to
frame the loading-screen JPG.

### Track stats

Read-only counts + spline length + lap-time estimate + terrain
extents + water coverage.

| Operator | What it does |
|---|---|
| **Refresh Terrain Stats** | Evaluates the terrain mesh and stashes min/max y + water-coverage fraction on scene custom properties. |

Cheap counts (gates, starts, pickups, boosts, anti-grav zones,
wave zones, emitters) recompute on every redraw. The terrain heavy
lift is gated behind the button so the panel stays responsive.

---

## Track-mode header operators

These live above the sub-panels (always visible in track mode):

| Operator | What it does |
|---|---|
| **Export Track to Game** | Validates the scene, writes `public/assets/tracks/<id>.glb`, merges the Blender-owned fields into `public/tracks/<id>.json` (preserving editor-owned fields), upserts the manifest entry, and auto-fires the hero render. |
| **Lint Track** | Pre-export sanity check — walks the spline, start, terrain, wave zones, and anti-grav zones. Reports errors + warnings without modifying anything. |
| **Reload from JSON** | Pulls scalar fields from `public/tracks/<id>.json` back into the scene custom properties (gate spacing, terrain shader, water, sky preset, start pose). |
| **Re-tag Scene by Name** | Walks every object whose name matches a recognised pattern (`cp_NN`, `pickup_*`, `start_NN`, `boost_NN`, `antigrav_NN`, `wave_zone_NN`, `water_volume_*`, `ai_spline_*`, `horizon_ring`, `emitter_NN`) and sets / corrects its `kind` extra. Useful after renames or when porting an old `.blend` that pre-dates a `kind` value. |
| **Open in Browser → Play** | Opens `http://localhost:5191/?track=<id>`. |
| **Open in Browser → Edit** | Opens `?track=<id>&edit=1` (in-app editor). |
| **Copy Play URL** | Copies the Play URL to the clipboard. |
| **Copy Edit URL** | Copies the Edit URL. |

### Export Track to Game

The export merges with the existing JSON instead of overwriting,
so in-app editor saves survive Blender re-exports. The contract:

| Field | Who owns it |
|---|---|
| `environmentGlb` | Blender (always) — points at the just-written .glb |
| `water` | Blender — `wave_height` / `wave_freq` from `water_volume_main` extras, height from its Z |
| `terrainShader` | Blender — the `hoverbike_shader_*` scene props |
| `aiSplines` | Blender — baked from `ai_spline_main` (and `ai_spline_alt_*` if present) |
| `gateSpacing` | Blender — `hoverbike_gate_spacing` |
| `start` | Blender — `start_00`'s transform |
| `horizon` | Blender — when a `horizon_ring` mesh is present, its block in the JSON is updated alongside the GLB mesh; otherwise the procedural-fallback knobs from the sub-panel are written |
| `sky` | Blender — every sky-preset scene prop |
| `checkpoints` | Blender if the .blend has `cp_NN` empties; editor otherwise |
| `pickups` | Blender if the .blend has `pickup_*` empties; editor otherwise |
| `boostPads` | Blender if the .blend has `boost_NN` empties; editor otherwise |
| `antiGravZones` | Blender if the .blend has `antigrav_NN` empties; editor otherwise |
| `waveZones` | Blender if the .blend has `wave_zone_NN` empties; editor otherwise |
| `audio` | Editor only — there's no Blender side to audio (music + ambient gains) |
| Anything else (props, sky overrides, etc.) | Editor — preserved through Blender exports |

Pre-export the addon also bakes any NURBS / Bezier curves to flat
point arrays in `extras` (glTF doesn't carry curves natively), so
the runtime loader sees the racing line as a polyline.

---

## Bike-mode operators

| Operator | What it does |
|---|---|
| **Export Bike to Game** | Validates the bike scene, writes `public/assets/bikes/<id>.glb`. On first export materialises a starter `specs/bikes/<id>.json` from `bike_root` extras + authored materials. Shift-click to force-rewrite the spec. |
| **Copy Play URL** | Copies `http://localhost:5191/?bike=<id>`. |
| **Copy Viewer URL** | Copies `http://localhost:5191/?viewer=<id>` — the stand-alone bike viewer (turntable, sockets, collider gizmos). |

Subsequent exports preserve `specs/bikes/<id>.json` so JSON-side
tuning isn't blown away by a re-export. Shift-click **Export Bike
to Game** to overwrite.

For everything bike-specific, see [Modding → Authoring bikes](/modding/bikes).

---

## Top-bar Hoverbike menu + Shift+H pie

Every operator is also reachable from the top-bar **Hoverbike**
menu (next to View / Select / Add) and the `Shift+H` pie menu in
the 3D viewport. The submenus group operators by intent rather
than by sub-panel:

| Submenu | Contents |
|---|---|
| **Add** | Add Water Volume, Wave Zone, Anti-Grav Zone, Anti-Grav Curve, Boost Pad, Ramp, Emitter, Downtown, Horizon Ring, Camera Hero, Tunnel Starter Curve, Road Curve, Placement Helper. |
| **Build / Refresh** | Build Road, Build Tunnel, Build Anti-Grav Surface, Rebuild Gate Preview, Rebuild Racer Preview, Rebuild Water Preview, Rebuild Ghost Lap, Rebuild Turn Indicators, Refresh Wave Zone Visuals, Refresh Anti-Grav Zones, Refresh Boost Pads. |
| **Spline** | Snap Spline to Terrain, Cursor → Spline, Snap Starts to Spline, Add Ramp at Spline t, Auto-place Ramps, Toggle Spline Anti-Grav, Tilt presets. |
| **Terrain** | Import Heightmap, Apply Terrain Modifiers, Subdivide Terrain, Sculpt Terrain, Raise / Lower @ cursor, Smooth Terrain, Bake AO + Path Wear, Bake Path-Worn. |
| **Thumbnail** | Render Hero, Render Tile Only. |
| **Utility** | **New Map from Template** (duplicate-and-open a `template-*.blend`), Re-tag Scene by Name, Lint Track, Reload from JSON. |

The `Shift+H` pie surfaces the most-used spawn / build operators
in a radial menu for keyboard-driven editing.

---

## Live previews and auto-rebuild

The addon registers a persistent `depsgraph_update_post` handler
that watches `ai_spline_main`, `start_00`, `water_volume_main`,
every `wave_zone_NN`, every `antigrav_NN`, and every `boost_NN`.
Edits to any of them schedule a debounced (~200 ms) rebuild of the
matching preview collections.

The `update=` callbacks on the spacing / curb / wave-time scene
props go through the same scheduler, so scrub interactions update
live without manual rebuilds.

Preview collections (`_hoverbike_gate_preview`,
`_hoverbike_racer_preview`, `_hoverbike_water_preview`,
`_hoverbike_turn_preview`, `_hoverbike_boost_pad_preview`,
`_hoverbike_antigrav_zone_preview`,
`_hoverbike_wave_zone_preview`, `_hoverbike_ghost_lap_preview`,
`_hoverbike_tunnel_cutters`) are hidden from render and scrubbed
at export — they never ship in the GLB.

The `load_post` handler auto-runs **Reload from JSON** when you
open a track `.blend`, so the editor-saves-then-reopen-in-Blender
loop is seamless.

The `auto_tag` module attaches a second `depsgraph_update_post`
hook that detects newly-created or renamed objects matching a
known naming pattern and writes the matching `kind` extra
automatically — so duplicating a `wave_zone_00` to `wave_zone_01`
keeps its tagging without authors touching Custom Properties.

---

## Headless builders

Three Python scripts run via `blender --background` produce GLBs
without opening Blender's GUI. They share the validation / extras
code with the addon (`hoverbike_addon/_legacy.py`), so what passes
the addon's lint passes the headless builder.

### `build_bike.py`

```bash
HOVERBIKE_SPEC=specs/bikes/scout.json \
HOVERBIKE_OUTPUT=public/assets/bikes/scout.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_bike.py
```

Opens `bikes-src/<id>.blend` (the variant's standalone scene),
applies any `appearance` recolour + `physics` extras from the
spec, validates the scene, exports. The script ignores the spec's
`geometry` and `rider` blocks (legacy fields).

Driven by `pnpm gen:bikes` for all bikes.

### `build_track.py`

```bash
HOVERBIKE_SPEC=specs/tracks/calibration.json \
HOVERBIKE_OUTPUT=public/assets/tracks/calibration.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_track.py
```

For **spec-driven** tracks. Reads the JSON spec, constructs the
scene programmatically (drivable slab, water volume, checkpoints,
AI spline, starts, pickups), saves a `.blend` to
`tracks-src/<id>.blend` for follow-up authoring, then invokes the
exporter for the GLB.

Use `HOVERBIKE_SKIP_BLEND_SAVE=1` for GLB-only mode (CI), or
`HOVERBIKE_BLEND=/some/other/path.blend` to override the `.blend`
save path.

Driven by `pnpm gen:tracks` for all spec-driven tracks.
**Editor-driven tracks** (everything authored in `.blend`s by hand)
bypass this script entirely — the addon's Export Track to Game
writes the GLB directly.

### `build_prop.py`

```bash
HOVERBIKE_SPEC=specs/props/palm.json \
HOVERBIKE_OUTPUT=public/assets/props/palm.glb \
  "$BLENDER_EXE" --background --python tools/blender/build_prop.py
```

Assembles a prop GLB from `tools/blender/lib/prop_kit.blend`'s
kit parts per the spec — scale, tint, primitive collider.

Driven by `pnpm gen:props`.

### `build_sprite_atlas.py`

```bash
pnpm gen:fx-atlas
# or directly:
python tools/blender/build_sprite_atlas.py
```

Pillow-only (no Blender). Packs the 16 sprite cells described in
the [Emitters](#emitters) sub-panel into the shared
1024×1024 4×4 atlas at `public/assets/fx/particle-atlas.png`. Run
after adding / tweaking a cell sprite.

### `run.mjs` — Node wrapper

```bash
node tools/blender/run.mjs build_track specs/tracks
```

Cross-platform wrapper. Discovers specs in the directory,
ajv-validates each against `specs/_schema/<category>.json`, spawns
Blender once per spec with the right env vars, then writes
`public/assets/manifest.json` with every category re-merged.

The `pnpm gen:bikes` / `gen:props` / `gen:tracks` scripts call
this with the appropriate builder + dir. `pnpm gen:all` runs all
three sequentially.

### `lint_track.py` + `run-lint.mjs` — CI lint

```bash
pnpm gen:tracks:validate
```

Loops over every `tracks-src/*.blend` (skipping asset libraries —
`props-library`, `landmarks-library`, `calibration`) and runs
`lint_track.py` against it. Output is one
`[lint:<trackId>] ERROR|WARNING: <message>` line per finding.
Exit code 1 if any track has at least one ERROR. PRs that touch
`tracks-src/`, `tools/blender/`, or `specs/` trigger the
`asset-pipeline` workflow which runs this against every track.

Checks the CI lint covers beyond the in-editor pass:

- `start_01` presence (in-editor lint only checks `start_00`).
- `cp_NN` index contiguity by *name* (not just by `index` extra).
- Every `kind=track` mesh has positive evaluated area.
- Every `wave_zone_NN` empty has positive half-extents on all three
  axes and a positive `height_mult`.
- At least one `pickup_*` exists (warning, not error — tutorial
  tracks may legitimately omit pickups).

### `inspect_glb.mjs` — quick GLB inspection

```bash
node -e 'import("./tools/blender/inspect_glb.mjs").then((m) =>
  m.inspect("public/assets/tracks/test-ring.glb"))'
```

Prints the GLB's `extensionsUsed`, node count, kind distribution,
and a few sanity checks. Useful when something's missing from the
runtime — confirm the GLB actually has what you expect.

---

## Seed scripts

One-shot Python scripts that materialise canonical `.blend` files
from code. Run with:

```bash
"$BLENDER_EXE" --background --python tools/blender/seed_<name>.py
```

| Script | Produces | Purpose |
|---|---|---|
| `seed_template_island.py` | `tracks-src/template-island.blend` | Procedural island reference scene with the `HV_Island` GN graph. |
| `seed_template_alpine.py` | `tracks-src/template-alpine.blend` | Alpine peaks template. |
| `seed_template_dunes.py` | `tracks-src/template-dunes.blend` | Dunes template. |
| `seed_template_mesa.py` | `tracks-src/template-mesa.blend` | Mesa / canyon template. |
| `seed_template_downtown.py` | `tracks-src/template-downtown.blend` | Procedural downtown reference scene with multiple terrain grades. |
| `seed_template_tunnels.py` | `tracks-src/template-tunnels.blend` | Three mountains, one hand-authored tunnel through each, AI spline threading all three. |
| `seed_template_tunnel_island.py` | `tracks-src/template-tunnel-island.blend` | Older tunnel-through-island reference. |
| `seed_template_antigrav_showcase.py` | `tracks-src/template-antigrav-showcase.blend` | Tube + ribbon + banked-strip reference for the anti-grav surface tool. |
| `seed_track_*.py` | `tracks-src/<id>.blend` | Per-track seeders — one per ship-quality v1 track (Aqualand, Marina Bay 7, Liberty Drowned, Shibuya Submerged, Cape Town Drift, Doge's Drift, The Maw, South Beach Sunken, Hatteras Light, Kilauea Crown, Angkor Drowned, Sandbar). |
| `seed_props_library.py` | `tracks-src/props-library.blend` | The shared prop library — `prop_gate_mesh`, etc. Linked (not appended) from track `.blend`s, so re-running this re-flows every track. |
| `seed_landmarks_library.py` / `seed_landmarks_showcase.py` | `tracks-src/landmarks-library.blend` / `landmarks-showcase.blend` | Per-city skyline / set-piece landmark meshes (Statue of Liberty, Doge's Palace, Marina Bay Sands, etc) and a calibration scene that lays them out. |
| `seed_prop_kit.py` | `tools/blender/lib/prop_kit.blend` | Placeholder kit parts for `build_prop.py`. |
| `seed_bike_kit.py` | (legacy) `tools/blender/lib/bike_parts.blend` | Pre-M9.38 bike kit — no longer wired up; bikes are now standalone `.blend`s. |

Seed scripts are committed source-art generators: their outputs
are `.blend` files that **do** get committed (for tracks /
libraries that humans then hand-edit). Re-running a seed
overwrites the file, so use them as starting points, not
roundtrip-tools.

The **New Map from Template** operator (Hoverbike → Utility) is
the user-facing wrapper around the template seeds: pick a template
from the dropdown, type a new track id, hit OK — the addon copies
the template to `tracks-src/<id>.blend` and opens it for editing.

---

## Validation rules

Both the addon's pre-export check and the headless builders run
the same validator. It rejects the export if:

- An object whose name matches a recognised pattern (`cp_NN`,
  `pickup_*`, `start_NN`, `boost_NN`, `antigrav_NN`,
  `wave_zone_NN`, `water_volume_*`, `ai_spline_*`, `emitter_NN`,
  `horizon_ring`) doesn't have a `kind` extra, or its `kind`
  disagrees with the name. **Re-tag Scene by Name** fixes most of
  these in one click.
- Checkpoints aren't contiguous from 0 (`cp_00`, `cp_02` with no
  `cp_01`).
- A checkpoint is missing `half_width` or `height`.
- There's no `ai_spline_main`, or its baked points array is empty.
- A `wave_zone_NN` empty has a non-positive `half_*` extent or
  `height_mult`.
- A `wave_zone_NN` empty has only one of (`surge_period_s`,
  `surge_amplitude`) set — both must be present together.
- A bike `.blend` is missing any of the five required sockets
  (`socket_seat`, `socket_nose_cam`, `socket_fx_thruster_l`,
  `socket_fx_thruster_r`, `socket_fx_exhaust`), or has no
  collider empty.

For the full naming + kinds matrix see [Scene conventions](./scene-conventions).

---

## Troubleshooting

**Sidebar panel disappeared / operator missing.** The installed
addon has drifted from the repo. Re-run `pnpm install:blender-addon`
and `F3 → Reload Scripts` in Blender.

**A sub-panel never appears even though I have the right object.**
Sub-panels are selection-driven — make the matching object active
(click it in the viewport or Outliner). Or use **Hoverbike → Add**
to spawn one. Sub-panels never registered are a different problem —
re-run the install script.

**`pnpm test:blender` fails with "could not locate Blender".**
Set `BLENDER_EXE` to the absolute path of the Blender 5.1
executable. The smoke test, headless builders, and `pnpm gen:*`
all use the same env var.

**Active modifiers blocking the road tool.** Toggle **Apply
modifiers first** in the Build Road redo panel — the procedural
GN graph (e.g. `HV_Island`) gets baked into vertex data so the
road's flatten isn't overridden. One-way; save first.

**Spline auto-snap drags a point onto the seafloor.** The snapper
clamps to whichever is higher: terrain Z or water surface Z. If
your `water_volume_main` is below the seafloor at that x/y, no
clamp applies. Lift the water volume or accept that point will
sit on the seabed.

**Track exports cleanly but renders sideways.** The Blender → glTF
Y-up conversion swaps axes. The builders compensate by authoring
with the bike's nose at Blender +Y / `start_00`'s +Y forward, so
they land at three.js +Z. If you've custom-rotated objects after
adding them, double-check via the bike viewer (`?viewer=<id>`).

**Lint warns about "spline points below water surface".** Re-run
**Snap Spline to Terrain** with a hover height that lifts above
the water plane, or lift the racing line manually. Lint clamps
the threshold at `water_z - 0.5 m` so a few cm below is fine.

**Boost pad / wave-zone gizmo doesn't update when I rotate it.**
Trigger the depsgraph by clicking elsewhere then back, or click
**Refresh Boost Pads** / **Refresh Wave Zone Visuals** in the
matching sub-panel.

**Wave zone has a visible boundary line in the runtime.** Increase
`blend_radius_m` — at 0 the zone is a hard cutoff; the default 20 m
keeps the boundary invisible at the racer's altitude.

**Wave zone surge does nothing.** Both `surge_period_s` AND
`surge_amplitude` must be present together. The validator rejects
half-specs; if your zone has only one of the two, the export
fails before the runtime gets a chance.

For more — and the underlying object kinds reference — see
[Scene conventions](./scene-conventions).
