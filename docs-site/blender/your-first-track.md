# Your first track — blank scene to playable map

A guided walk-through, from File → New to a track you can race in
your browser. The shortest path uses the in-Blender addon end-to-end:
no JSON editing, no terminal beyond `pnpm dev`. Expect this to take
about **20–30 minutes** the first time; ~5 minutes once you've done
it once.

::: tip Before you start
- Blender 5.1+ installed; addon installed (`pnpm install:blender-addon`)
  and enabled in Preferences → Add-ons. See [Overview → one-time setup](./overview#one-time-setup).
- The dev server running: `pnpm dev` → `http://localhost:5191`.
- Optional but recommended: a heightmap PNG handy if you want a
  natural-looking terrain instead of sculpting one from scratch.
:::

::: warning Where you save matters
The filename and parent directory are how the addon decides which
mode to enter. Save your track as `tracks-src/<id>.blend` inside
your hoverbike clone. The basename (`<id>`) becomes the in-game
track id; `tracks-src/sandbar.blend` plays at
`http://localhost:5191/?track=sandbar`.
:::

## Big picture

You'll do **six things** in this order. Each builds on the
previous; you can jump back to any step and rerun.

1. [Save the blank scene under the right name](#_1-save-the-blank-scene)
2. [Add terrain](#_2-add-terrain) — either heightmap-imported or sculpted by hand.
3. [Author the racing line](#_3-author-the-racing-line) (`ai_spline_main`) and snap it to the terrain.
4. [Place the start grid](#_4-place-the-start-grid).
5. [Add water + sea level](#_5-add-water-and-sea-level).
6. [Lint + Export](#_6-lint-export-playtest) → playtest in the browser.

Optional follow-ups (any order, in either Blender or the in-app
editor): roads, tunnels, ramps, downtown, gates, boost pads,
pickups. Those are covered after the core walk-through.

## 1. Save the blank scene

In Blender:

1. **File → New → General**. Delete the default cube, camera, and
   light (`A` then `X`).
2. **File → Save As…** → navigate into `tracks-src/` in your repo
   clone → name the file `<id>.blend` (use lowercase letters,
   digits, dashes — that becomes your in-game track id). Save.

The addon detects "track mode" from the parent directory. Press
**N** in the 3D viewport → switch to the **Hoverbike** tab. You
should see the track header with your id, a big **Export Track to
Game** button, and a stack of collapsible sub-panels.

::: tip Saving creates a starter JSON later
Until you click **Export Track to Game** at least once, there's no
gameplay JSON for this track. The first export materialises
`public/tracks/<id>.json` with default values; subsequent exports
preserve everything the in-app editor saves on top.
:::

## 2. Add terrain

You need at least one mesh tagged `kind="track"` for the bike to
land on. Two paths:

### A. Heightmap import (recommended for natural terrain)

1. Hoverbike sidebar → **Terrain** sub-panel → adjust *Size*,
   *Subdiv*, *Δz (m)*, and *Base z* sliders.
   - **Size** (default 600 m) — the side length of the square plane.
   - **Subdiv** (default 256) — vertex count per side. Higher = more
     fidelity, slower exports. 256 is a good baseline.
   - **Δz (m)** — vertical range. 60 m gives gentle rolling hills;
     200 m gives mountains.
   - **Base z** — the world Z of the lowest pixel. Set to 0 for
     hills above sea level; negative for islands surrounded by water.
2. Click **Import Heightmap** → file picker → pick a greyscale
   PNG/EXR (or generate one elsewhere, e.g. in GIMP / Krita). The
   importer luminance-displaces every vertex and tags the output
   mesh `terrain_heightmap` with `kind=track`.

Re-import replaces the previous mesh, so iterating is cheap.

### B. Sculpt from scratch

1. **Add → Mesh → Plane**. Resize to your desired track footprint
   (`S` then type a number, e.g. `300` for a 600×600 m plane —
   Blender's plane is 2×2 by default).
2. Right-click → **Shade Smooth** (optional, looks nicer).
3. With the plane selected, go to **Object Properties → Custom
   Properties → New**, name it `kind`, type **String**, value
   `track`.
4. Hoverbike sidebar → **Terrain** sub-panel → **Subdivide Terrain**
   a few times to get enough verts to sculpt with (~10 k verts is
   plenty for a small track; 100 k for a large detailed one).
5. **Sculpt Terrain** switches you into Blender's Sculpt Mode with
   the terrain selected. From there: **Draw** + **Smooth** to
   build hills, **Flatten** to level a racing line, **Grab** to
   pull peaks. Tab out when done.

Alternatively, use the panel's **Raise / Lower @ cursor** for
bulk shaping: set *Radius* and *Δz peak*, position the 3D cursor
where you want the bump, click. Faster than brush strokes for
large hills.

### Decoration vs. drivable

Any extra meshes (rocks, props, scenery) you add later default to
**collidable** — every mesh in the GLB gets a static Rapier trimesh
collider. For purely visual decoration, set the mesh's custom
property `kind = "decoration"` (or just leave `kind` unset and put
it in a hidden collection).

## 3. Author the racing line

The **AI spline** (`ai_spline_main`, a NURBS curve) does two jobs:
the AI bikes follow it, and the gate placement runs along it. A
track without an AI spline won't lint clean.

1. **Add → Curve → Bezier** → rename it `ai_spline_main` in the
   Outliner.
2. Object Properties → Custom Properties → add `kind` = `ai_spline`
   (String) and `branch` = `main` (String).
3. Tab into edit mode and shape the racing line. A handful of
   control points (8–12) is plenty — the runtime resamples it into
   a dense polyline. **Close the loop:** Curve menu → *Toggle
   Cyclic*, or `Alt+C`.
4. Tab back out.
5. Hoverbike sidebar → **Spline tools** → adjust *Hover (m)*
   (default 3 m) to a comfortable racing altitude → click **Snap
   Spline to Terrain**. Every control point raycasts straight down
   onto the terrain and lifts by the hover height.

::: tip Make sure your loop sits cleanly above the surface
After snapping, eyeball the curve — it should hug the terrain
profile with a constant clearance. If a point lands on the water
surface instead of solid ground, that's expected (water counts as
drivable). If a point lands on a road slab you authored, the
snapper hides `road_main` during the raycast — but only if you've
clicked **Build Road** already.
:::

## 4. Place the start grid

1. **Add → Empty → Arrows** → rename `start_00`. The empty's local
   +Y axis is the direction the racer faces; rotate around Z to aim.
2. Custom properties: `kind` = `start`, `index` = 0 (Int).
3. Hoverbike sidebar → **Spline tools** → set *Start gap* (default
   ~5 m) → click **Snap Starts to Spline**. The operator
   repositions `start_00` (and `start_01` if you've added one) on
   the racing line, lined up perpendicular to the tangent at
   parameter `t = 0`.

For a multi-bike grid, duplicate `start_00` (Shift+D) and rename
the copy `start_01`. The AI bikes spawn in slots defined by
`specs/grid-offsets.json` — you can preview them with **Rebuild
Racer Preview** in the Gameplay sub-panel.

## 5. Add water and sea level

Even on a tracks-above-sea-level track, the runtime needs a water
volume — the wave field renders everywhere outside drivable
geometry, and the bike's "ride waves" rule kicks in below water.

1. Hoverbike sidebar → **Water** sub-panel → click **Add Water
   Volume**. The addon creates `water_volume_main`, a cube-shaped
   empty with the right `kind` / `wave_height` / `wave_freq`
   extras. The wave preview plane appears automatically.
2. Scrub **Sea level (m)** to set the surface height. Negative
   values give an island; positive values flood the basin.
3. Optionally tune **Wave preview** *Size*, *Subdiv*, *Time* to
   judge the look — these don't affect the export, only the
   in-Blender gizmo.

If you'd rather drag the volume in the viewport, just grab the
`water_volume_main` empty along Z — the preview follows live via
the addon's depsgraph hook.

## 6. Lint, Export, playtest

### Lint

Hoverbike sidebar → top of the panel → **Lint Track**. Walks the
spline, the start pose, and the terrain looking for the failure
modes that bite at runtime:

- Spline points below the water surface (bike dives underwater).
- Spline points with no terrain or water beneath (bike falls into the void).
- Spline points sitting above non-`kind=track` meshes (no collider).
- Missing `start_00`, missing `ai_spline_main`, no `kind=track` terrain.
- Sparse / busy gate density given the spline length.

Errors block the export; warnings let you proceed but flag scenes
that'll race oddly. Fix anything the linter flags, then re-lint.

### Export

Hoverbike sidebar → top → **Export Track to Game**. The button is
the big one above Lint. The addon:

1. Validates the scene (same checks as Lint, plus naming/extras consistency).
2. Bakes any NURBS curves to flat point arrays in glTF `extras`.
3. Writes `public/assets/tracks/<id>.glb`.
4. Writes `public/tracks/<id>.json` (first export) or merges into
   the existing JSON (subsequent exports — your editor saves
   survive).
5. Upserts the track into `public/assets/manifest.json` so the
   in-game level picker sees it.

You'll see a green toast: `Exported → public/assets/tracks/<id>.glb (created public/tracks/<id>.json)`. Red toasts are validation
failures — read each one and fix the offending object.

### Playtest

In the addon panel:

- **Play** opens `http://localhost:5191/?track=<id>` in your
  default browser.
- **Edit** opens the same URL with `&edit=1` so you can re-tune
  gameplay placement live in the in-app editor.
- **Copy Play URL** / **Copy Edit URL** for pasting elsewhere.

The dev server is already aware of the new track — no code change
needed; the level picker will list it on next reload.

::: tip First playtest checklist
- Press `T` to enable AI autoplay and watch a bot lap your spline.
- Press `Backspace` to respawn at `start_00` if you get stuck.
- Open the dev tools console for any GLB load errors.
- If the bike falls through, your terrain mesh probably isn't
  tagged `kind=track`.
:::

You now have a playable track. The rest of this page is **optional
authoring** — features you can layer on top.

---

## Optional: roads

Drop a Bezier curve, conform the terrain to it, get a banked F1
ribbon with curbs.

1. Hoverbike sidebar → **Road tool** → **Add Road Curve**. Creates
   `road_curve_main`, a 4-point Bezier near the origin.
2. Tab into edit mode and shape it. Per-control-point **Tilt**
   (N-panel → Curve → Tilt) lets you hand-tune banking at specific
   corners on top of the auto-bank.
3. Tab out. Adjust the panel sliders:
   - **Width** (8 m), **Lift** (0.15 m), **Slab** (0.6 m) for the
     basic dimensions.
   - **Bank** (0.6) + **Max°** (25°) for the auto-banking driven
     by curvature.
   - **Curb w** / **Curb h** / **Stripe (m)** for F1-style curbs
     (set Curb w = 0 to disable).
4. Click **Build Road**. The terrain is conformed to the road's
   altitude profile in a `width/2 + curb_width + blend_radius`
   band; the road mesh is emitted with `kind=track`.

::: warning Procedural terrain
If your terrain has active modifiers (e.g. the `HV_Island` Geometry
Nodes template), the road tool errors out by default — the GN graph
would stack on top of the road's vertex edits, producing spikes.
Toggle **Apply modifiers first** in the Build Road redo panel to
bake the modifier in. One-way: parametric tunability is lost in
exchange for a drivable road. Save first.
:::

## Optional: tunnels

Drill a tunnel through a hill with a Bezier curve and a boolean.

1. Hoverbike sidebar → **Tunnels** → **Add Tunnel Starter Curve**.
   Creates `tunnel_curve_main` near the origin.
2. Tab into edit mode. Drag handles **into** the hillside on one
   side and **out** the other. For clean tunnel mouths, place the
   endpoint anchors slightly *below* the terrain surface (use
   *End extend* in the panel to push the cap further past the
   hillside if needed).
3. Set dimensions: **Radius** (8 m), **Wall** (1 m), **Samples** (32), **Sides** (14), **End extend** (4 m).
4. Click **Build Tunnel**. The addon emits a cutter cylinder + an
   interior shell, and adds a Boolean DIFFERENCE modifier to the
   terrain that targets the cutters collection.

To author a second tunnel, rename `tunnel_curve_main` (e.g. to
`tunnel_curve_main_old`), then rerun **Add Tunnel Starter Curve**
and **Build Tunnel** — the boolean modifier picks up the next
cutter automatically.

For a reference scene with multiple tunnels, see
`tracks-src/template-tunnels.blend`.

## Optional: stunt ramps

Drop a parametric wedge at the 3D cursor.

1. Position the 3D cursor — either move it manually (`Shift+S` →
   *Cursor to Selected*) or use the **Placement helper** for
   spline-aligned drops.
2. Hoverbike sidebar → **Ramps** → adjust **Length**, **Width**,
   **Height** → **Add Ramp**.
3. Edit Length / Width / Height live on the ramp's HV_Ramp modifier
   to resize after placement.

Bulk-place ramps at every curvature peak above a threshold via
**Spline tools → Auto-place Ramps**.

## Optional: downtown

Procedural city block at the 3D cursor.

1. Position the 3D cursor at the city's centre.
2. Hoverbike sidebar → **Downtown** → adjust **X** / **Y** (block
   grid), **Block** / **Street** (sizing), **Min h** / **Max h**
   (building height range), **Seed** (deterministic layout) →
   **Add Downtown**.
3. The generator parents a flat plinth + a grid of building
   placeholders under a `downtown_NN` empty, all tagged
   `kind="track"`. The plinth raycasts onto the largest visible
   `kind="track"` mesh — buildings step into hillsides correctly.

## Optional: gates

The runtime expects checkpoints along the racing line. Two ways to
get them:

- **In Blender (live preview):** Hoverbike sidebar → **Gameplay**
  → adjust **Spacing**, **Half-width**, **Height** → **Rebuild
  Gate Preview**. The addon instances the real `prop_gate_mesh`
  from `tracks-src/props-library.blend` every `spacing` metres
  along the spline. On export the JSON's `gateSpacing` field
  drives the runtime — no `cp_NN` empties needed.
- **In the in-app editor:** open `?track=<id>&edit=1`, drag gates
  manually. Hand-placed gates take precedence over `gateSpacing`.

## Optional: boost pads

Hoverbike sidebar → **Gameplay** → **Add Boost Pad**. Creates a
`boost_NN` empty at the 3D cursor. The empty's local +Y axis is
the boost direction; rotate around Z to aim. Custom properties
(`half_width`, `half_depth`, `strength`) are pre-filled with sane
defaults.

## Optional: pickups

Add an empty (any shape), name `pickup_<anything>`, set custom
property `kind = "pickup_spawn"`. The runtime rotates through
pickup types at each spawn. Or hand-place pickups in the in-app
editor instead.

## Optional: wave zones

For tracks where the water matters — surf swells along the start
chute, a periodic tsunami sweeping the final straight, a glass-calm
harbour at the apex — drop one or more `wave_zone_NN` empties.

1. Hoverbike sidebar → **Wave zones** → **Add Wave Zone**. Drops
   a `wave_zone_00` empty (cube display) at the 3D cursor with a
   translucent cyan box gizmo so the volume reads in the viewport.
2. **Local +X is the dominant swell direction.** Rotate around Z
   (`R Z 45`) to aim the swell, then scale by editing the
   `half_width` / `half_height` / `half_depth` custom properties.
3. Tune `height_mult` and `freq_mult` in the Object Properties
   panel — defaults of `1.5 / 1.0` give a visible swell bump over
   the global field. Bigger / smaller for showier or calmer.
4. (Optional) For a tsunami timer, add `surge_period_s` and
   `surge_amplitude` together (e.g. `12.0 / 4.0` for a slow
   12-second 4 m wave wall).

The zone's effect rounds-trips through `waveZones[]` in the JSON
on the next *Export Track to Game*. The Wave-zones merge is opt-in:
if the `.blend` has any `wave_zone_NN` empties, Blender owns the
list; otherwise the in-app editor's placements stay through
re-exports.

For full worked examples — Aqualand tsunami, Cape Town swell at a
turn, Marina Bay harbour calm, Doge's Drift channelled chop — see
the [Wave zones cookbook](./wave-zones).

## Optional: horizon ring

The runtime gives every track a procedural distant-mountain
silhouette by default. To replace it with something recognisable
(Skytree behind Shibuya, Table Mountain behind Cape Town, the
Manhattan grid behind Liberty):

1. Hoverbike sidebar → **Horizon** → set Segments / Radius / Peak
   / Seed on the starter, then **Add Horizon Ring**. Drops
   `horizon_ring` (`kind=horizon`) at origin using the same
   layered-sine starter the runtime uses.
2. **Edit Horizon Ring** selects it and enters edit mode. Turn on
   Proportional Editing (`O`) and pull verts into your track's
   skyline.
3. The mesh ships in the GLB as a single draw call; the runtime
   replaces its procedural ring with your authored one
   automatically. Need a different procedural starter? **Reset
   Horizon Ring** re-seeds; **Delete Horizon Ring** drops back to
   the fallback.

## Optional: sky preset

Per-track tint, sun, fog, time-of-day, colour grade, sea state.
Hoverbike sidebar → **Sky preset** (default-closed between
Horizon and Wave zones). Tune to taste — every field is optional
and ships through the JSON's `sky` block on export. Reasonable
starting points:

| Look | Setting |
|---|---|
| Sunset glow | `tint = #ffd9a8`, `timeOfDay = 280`, `colorGrade = nyc_sunset` |
| Glass-calm dawn | `cloudiness = 0.1`, `seaStateBeaufort = 1`, `timeOfDay = 60` |
| Neon storm | `colorGrade = tokyo_neon`, `cloudiness = 0.8`, `seaStateBeaufort = 7` |
| Volcanic dusk | `colorGrade = kilauea_volcanic`, `tint = #ff8866`, `cloudiness = 0.6` |

The `seaStateBeaufort` knob scales every base wave amplitude at
boot, so it pairs with wave-zone `height_mult` — set Beaufort 6
for a stormy ambient field, then a `height_mult = 0.4` zone for
the calm harbour in the middle.

## Optional: particle emitters

Drop `emitter_NN` empties for steam, foam, embers, neon glare,
gulls — any localised VFX. The runtime spawns particles from each
empty's pose using a shared 16-cell atlas.

1. Hoverbike sidebar → **Emitters** → **Add Emitter**. Drops
   `emitter_NN` (SPHERE display) at the 3D cursor. Local +Y is
   the emission direction.
2. Pick `atlas_cell` in Object Properties (0 = spark, 1 = smoke
   puff, 2 = ember, 3 = foam, 4 = dust, 5 = gull, 7 = neon, etc).
   The full legend is in [Addon reference → Emitters](./addon-reference#emitters).
3. Tune `emit_rate`, `lifetime_s`, `velocity_cone_deg`,
   `speed_*`, `size_*`, `color_*`, `gravity`, `max_particles`.

Cost: one draw call per atlas cell, not per emitter — two
`dust_mote` emitters on the same track share a call.

## Optional: hero render

Loading-screen art for the track-select grid.

1. Park the 3D cursor where you want the camera to sit. Hoverbike
   sidebar → **Track hero render** → **Add Camera Hero**. Drops
   `camera_hero` aimed at a sensible default target (`start_00`,
   the AI-spline mid-point, or world origin).
2. Translate / rotate to frame the track's signature set-piece.
3. **Render Hero** renders the full 1280×720 hero + 320×180 tile
   in one shot. EEVEE, sub-second on a modern GPU. JPGs land in
   `public/assets/tracks/<id>-hero.jpg` / `-thumb.jpg`.

Subsequent *Export Track to Game* auto-fires the render — the UI
art never drifts from the latest `.blend`.

## Iterate

Once exported, the iteration loop is **edit → Export → reload
browser tab**. The addon's depsgraph hooks update previews live,
so you can scrub gate spacing or wave height and see the result
without re-exporting.

When you want to fine-tune gate placement, pickup positions, or
boost pad orientation without reopening Blender, jump into the
in-app editor: click **Edit** in the addon panel or open
`?track=<id>&edit=1`. Saves there round-trip through
`public/tracks/<id>.json` — next time you open the .blend, the
**Reload from JSON** button (auto-fired on open) pulls those
changes back into the scene.

For the round-trip contract — which fields Blender owns vs. which
fields the editor owns — see [Addon reference → Export Track to Game](./addon-reference#export-track-to-game).

## Where to go next

- **Full operator + panel reference** → [Addon reference](./addon-reference).
- **The naming + extras matrix** → [Scene conventions](./scene-conventions).
- **Tracks edited in the in-app editor instead of Blender** → [Modding → Tracks](/modding/tracks#editor-driven-authoring).
- **Spec-driven (declarative) tracks** → [Modding → Tracks](/modding/tracks#spec-driven-authoring).
