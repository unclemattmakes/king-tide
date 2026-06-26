# Anti-grav surfaces cookbook

> **PARKED — anti-grav is cut from races** (kept for a possible future DLC). **No
> shipped track uses it;** verticality comes from terrain, ramps, berms, and cliffs.
> This page is kept in the repo for the possible DLC but is excluded from the built
> docs site (`srcExclude` in `.vitepress/config.ts`). The cookbook below is preserved
> for reference — don't present it to a newcomer as a live authoring path, and don't
> author anti-grav into a v2 track.

In-depth recipes for the **anti-grav surfaces** authoring tool.
Sweep a cross-section profile (tube / ribbon / banked strip) along
a Bezier curve to produce a drivable corkscrew, wall-ride, or loop
— and let the tool auto-drop the entry / exit anti-grav zone
empties that flip the bike's gravity at the boundaries.

This page assumes you've already read [Your first track](./your-first-track).
For the operator reference see
[Addon reference → Anti-grav surfaces](./addon-reference#anti-grav-surfaces);
for the kind matrix see [Scene conventions](./scene-conventions).

## What it does

You author a Bezier curve. The tool:

1. Samples the curve along its arc length using a
   parallel-transport (rotation-minimising) frame so the
   cross-section doesn't flip mid-corkscrew.
2. Sweeps the chosen cross-section along the frame, emitting a
   single closed mesh tagged `kind="track"` with `anti_grav=true`
   extras so the runtime trimesh collider attaches.
3. Drops two oriented box empties at the curve endpoints —
   `antigrav_NN_zone_entry` and `antigrav_NN_zone_exit` — tagged
   `kind="antigrav_zone"`. The empties' local +Y points along the
   curve tangent so the bike enters the volume on approach.

The existing anti-grav controller (`src/game/sim/antigrav.ts`)
handles the actual gravity flip: while a bike is inside one of
the zone empties, its "up" rotates to align with the surface
normal of whatever it's standing on. The swept surface mesh is
just collidable geometry with a custom-shaped floor.

## Three profiles

Pick the profile in the sub-panel header (`hoverbike_antigrav_profile`
scene property):

### Tube (`TUBE`)

Closed cylinder along the curve. The bike can attach to any
point on the inside surface — drive up the wall, across the
ceiling, down the other side. Default radius matches the tunnel
tool's 8 m so anti-grav tubes feel sibling-scale.

**When to use:** corkscrews climbing a pillar, caldera loops,
anything fully enclosed, the inside of a vertical pipe.

**Sliders:** *Radius* (default 8 m), *Sides* (default 14 radial
segments), *Samples* (default 48 arc-length subdivisions).

### Ribbon (`RIBBON`)

Flat strip — `width × thickness`. Geometry-only: it's a slab.
Authors rotate the curve to stand the ribbon up (wall ride) or
hang it upside-down (ceiling).

**When to use:** wall-rides where the strip needs no banking
curve, the Liberty torch underside, a half-pipe lip when you
want the ride surface to be a flat ribbon rather than a banked
curve.

**Sliders:** *Width* (default 6 m), *Thick* (default 0.4 m),
*Samples*.

### Banked strip (`BANKED_STRIP`)

Slab whose per-sample tilt comes from each Bezier control point's
**Tilt** field. The same Tilt slider the road tool reads for road
banking — N-panel → Item → Tilt while in EDIT_CURVE mode.

| Tilt | Result |
|---|---|
| `0` | Flat ribbon |
| `±π/4` (~0.785) | 45° banked corner |
| `±π/2` (~1.57) | Vertical wall |
| `±π` (~3.14) | Ceiling (slab flipped upside-down) |

The **Anti-Grav presets** row in the Gameplay sub-panel (visible
in EDIT_CURVE mode on `ai_spline_main` *or* on an
`antigrav_curve_NN`) is one-click for these: **Flat / Bank L /
Bank R / Wall L / Wall R / Ceiling**.

**When to use:** a single sweep that transitions through multiple
states (flat → banked → vertical → ceiling and back). One curve,
one mesh, smooth interpolation between control-point tilts.

**Sliders:** *Width*, *Thick*, *Samples* (same as Ribbon).

## Recipe 1 — Pillar corkscrew (Tube)

Climb a 60 m pillar by spiralling around it.

1. **Hoverbike sidebar → Anti-grav surfaces.** Set Profile = TUBE,
   Radius = 6, Sides = 16, Samples = 96 (long sweep needs more
   samples to read smooth).
2. **Add Anti-Grav Curve.** Drops `antigrav_curve_00` at the 3D
   cursor. Move it to the base of the pillar.
3. **Edit the curve.** Tab in. Spread the four default control
   points out over two full turns around the pillar:
   - CP0 at the base, tangent pointing along the racing-line
     approach.
   - CP1 quarter-way up, displaced ¼ turn around the pillar.
   - CP2 three-quarters up, displaced ¾ turn.
   - CP3 at the top, tangent pointing out into the next section.
4. **Tab out, Build Anti-Grav Surface.** The operator sweeps the
   tube along the curve and drops `antigrav_00_zone_entry` /
   `_zone_exit` empties at CP0 and CP3.
5. **Adjust the zone empties** if the bike's gravity needs to flip
   slightly before / after the geometric tube — scale them along
   local +Y to extend the trigger volume.

To add a second corkscrew, click **Add Anti-Grav Curve** again
(spawns `antigrav_curve_01`), shape it, **Build Anti-Grav Surface**
emits `antigrav_01_*`. Each curve owns its outputs via custom
properties so a delete + rebuild wipes the right ones.

## Recipe 2 — Wall-ride along a building face (Ribbon)

A 30 m wall-ride attached to a vertical building face.

1. Profile = RIBBON. Width = 4 m (narrow), Thick = 0.3 m.
2. **Add Anti-Grav Curve.** Move it to the start of the wall-ride.
3. Tab into edit mode. **Rotate the entire curve 90° around its
   forward axis** so the curve's natural "up" points away from the
   building face. The ribbon will sweep flat against the wall.
4. Shape the curve along the wall face (4 control points along the
   building's edge is plenty for a straight wall-ride).
5. Tab out, **Build Anti-Grav Surface**. The ribbon mesh hugs the
   building; the entry / exit zones are aimed along the curve
   tangent.

The bike enters the entry zone, gravity rotates to align with the
ribbon's surface normal (which is now "out from the building
face"), the bike races along the wall, exits the exit zone,
gravity flips back to world-down.

::: tip Ribbon vs. banked-strip wall
Use **Ribbon** when the wall is a flat vertical surface and you
want a constant cross-section. Use **Banked strip** when the
surface needs to transition (flat → wall → flat) along the same
curve — banked strip handles the smooth interpolation; ribbon
gives you a rigid slab.
:::

## Recipe 3 — Full loop with smooth banking (Banked strip)

A 360° loop in a single curve.

1. Profile = BANKED_STRIP. Width = 8 m (wide enough for a
   racing line), Thick = 0.5 m, Samples = 96.
2. **Add Anti-Grav Curve.** Park it where the loop should sit.
3. Tab into edit mode. Add control points around a circle (Ctrl+
   click in edit mode to extrude, or duplicate the curve and
   reshape). For a planar loop in the XZ plane, place 5 control
   points around a circle of radius 15 m.
4. **Set each control point's Tilt** using the Anti-Grav presets
   row in the Gameplay sub-panel (or N-panel → Item → Tilt):
   - CP0 (entry): Tilt = 0 (flat)
   - CP1 (90° in): Tilt = π/2 (Wall L)
   - CP2 (180°, top of loop): Tilt = π (Ceiling)
   - CP3 (270°): Tilt = -π/2 (Wall R)
   - CP4 (exit): Tilt = 0 (flat)

   The tool interpolates tilt between control points using
   Blender's curve tilt evaluator, so the bank transitions are
   smooth.

5. Tab out, **Build Anti-Grav Surface**. Single closed slab mesh
   that loops, entry / exit zones at CP0 and CP4.

The presets are equivalent to manually setting:

| Preset | Tilt (radians) |
|---|---|
| Flat | `0` |
| Bank L | `-0.785` |
| Bank R | `+0.785` |
| Wall L | `-1.571` |
| Wall R | `+1.571` |
| Ceiling | `±3.142` |

Use whichever interface fits your flow — the presets are faster
during initial blockout, the Tilt slider is better for
fine-tuning between presets.

## Recipe 4 — Spline-driven main route + zone for the detour

For the main racing line, prefer the **spline anti-grav** flag
(toggle on the Gameplay sub-panel). The runtime auto-builds the
anti-grav corridor along `ai_spline_main` driven by each control
point's Tilt — no second curve to manage, the racing line and the
banking live together.

1. Open `ai_spline_main` in edit mode.
2. Per-control-point: pick a Tilt preset from the **Anti-Grav
   presets** row.
3. Click **Toggle Spline Anti-Grav** (Gameplay sub-panel) to flip
   `anti_grav=true` on the spline.

For **off-route stretches** (a side ramp, a wall-ride that
diverges from the racing line, an optional corkscrew), use the
curve-driven anti-grav surface tool — it gives you geometry the
spline doesn't.

Both approaches round-trip through `derive_track_json` so a track
can use either or both. The runtime applies the spline corridor
first; curve-driven surfaces stack on top.

## Authoring loop

1. **Pick the profile.** Tube / Ribbon / Banked strip.
2. **Add Anti-Grav Curve.** `antigrav_curve_NN` at the 3D cursor.
3. **Edit the curve.** Drag handles. For Banked strip, set
   per-control-point Tilt.
4. **Build Anti-Grav Surface.** Emits the swept mesh + the two
   zone empties.
5. **Tweak the zone empties** if the gravity-flip volume needs to
   extend past the geometric surface. Scale along local +Y to
   extend the trigger range; rotate to align the local +Y with
   the surface normal at the boundary.
6. **Rebuild in place** by re-clicking **Build Anti-Grav Surface**
   on the same curve — the existing surface + zones are replaced.
7. **Export Track to Game.** The swept mesh ships in the GLB; the
   zone empties serialise into `antiGravZones[]` in the JSON.

## Reference scene

`tracks-src/template-antigrav-showcase.blend` is the canonical
example — one tube corkscrew climbing a pillar, one ribbon
wall-ride along a building face, one banked-strip loop. Open it
to see all three profiles configured correctly side-by-side, or
duplicate it via **Hoverbike → Utility → New Map from Template**
to start a new track from it.

```bash
# Regenerate the showcase scene from code:
"$BLENDER_EXE" --background --python tools/blender/seed_template_antigrav_showcase.py
```

## Common mistakes

- **Cross-section flips mid-corkscrew.** The tool uses a
  parallel-transport (rotation-minimising) frame, so this
  shouldn't happen — but if you've manually edited the curve's
  Twist values, that overrides the frame. Reset Twist to 0
  (curve edit mode → Curve menu → Recalculate Handles, or
  manually zero each control point's Twist in N-panel → Item).
- **Build fails with "active object is not an antigrav curve".**
  Make sure an `antigrav_curve_NN` object is the active object
  (click it in the Outliner or viewport). The tool reads the
  active curve, not any-curve-in-the-scene.
- **The bike falls through the swept surface.** The mesh is
  emitted with `kind="track"` so the trimesh collider attaches at
  runtime. If the bike still falls through, check **Lint Track**
  — a `kind` mismatch or a mesh that wasn't actually built
  (silent on the operator's first run if the curve had < 2 control
  points) will show up there.
- **Bike's gravity doesn't flip on entry.** The
  `antigrav_NN_zone_entry` / `_zone_exit` empties' local +Y is the
  surface normal at the boundary. If the bike enters the volume
  but doesn't flip, the empties' rotation is wrong — re-run
  **Build Anti-Grav Surface** to re-derive them, or hand-rotate so
  local +Y aligns with the surface normal at the curve endpoint.
- **Two adjacent anti-grav surfaces have a visible discontinuity
  in the bike's tilt.** The two corresponding zone empties should
  overlap slightly (extend the exit zone of segment 0 into the
  entry zone of segment 1). The controller blends gravity targets
  during the overlap; non-overlapping zones snap the gravity flip
  hard.

## Performance

The swept mesh is a few hundred to a few thousand triangles
depending on the *Samples* slider — well within budget for the
runtime trimesh collider. The zone empties are just bounding-box
tests at runtime (one OBB query per bike per frame per zone).

The parallel-transport frame computation is done once at build
time, in Blender — runtime cost is zero beyond the standard
collider + zone test.

## See also

- [Addon reference → Anti-grav surfaces](./addon-reference#anti-grav-surfaces) — operator + property table.
- [Scene conventions → Object kinds](./scene-conventions#object-kinds-track-mode) — the `antigrav_zone` + anti-grav surface `kind` rows.
- `src/game/sim/antigrav.ts` — runtime controller for the gravity-flip behaviour.
- `tools/blender/hoverbike_addon/antigrav_ribbon.py` — addon source (the curve-driven sweep + zone emit).
- `tools/blender/hoverbike_addon/antigrav.py` — addon source (the free-standing zone empty for off-route stretches).
- `tools/blender/seed_template_antigrav_showcase.py` — the showcase seed script.
