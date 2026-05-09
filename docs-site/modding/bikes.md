# Authoring bikes

A bike is one JSON spec under `specs/bikes/<id>.json` plus the kit parts in `tools/blender/lib/bike_parts.blend`. Save the spec → the watcher rebuilds → reload your browser tab → the new bike is in the manifest.

## Quick add

```bash
# 1. Copy an existing spec
cp specs/bikes/scout.json specs/bikes/falcon.json

# 2. Edit id + displayName + the knobs you care about
#    (open specs/bikes/falcon.json in your editor)

# 3. Save — Vite's watcher rebuilds public/assets/bikes/falcon.glb

# 4. Try it in-game
open http://localhost:5191/?bike=falcon
```

To make it selectable from the Garage menu, also wire it into [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts). Otherwise the URL parameter is the only entry.

## Spec format

```json
{
  "$schema": "../_schema/bike.json",
  "id": "racer",
  "displayName": "Racer",
  "geometry": {
    "chassisLength": 2.5,
    "chassisWidth": 0.6,
    "chassisHeight": 0.4,
    "fairingStyle": "swept",
    "thrusterCount": 2,
    "thrusterSpacing": 0.4,
    "fork": "single"
  },
  "physics": {
    "massKg": 120,
    "topSpeedMps": 28,
    "hoverHeight": 1.2
  },
  "appearance": {
    "liveryColor": "#ff7733",
    "metalColor": "#222428",
    "glowColor": "#ffaa55",
    "glowIntensity": 1.4
  },
  "rider": {
    "seatOffset": [0, 0.55, -0.1]
  }
}
```

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable identifier matching `^[a-z][a-z0-9_-]*$`. Becomes the GLB filename. |
| `displayName` | string | yes | Shown in the manifest + the Garage menu. |

### `geometry`

| Field | Range | Notes |
|---|---|---|
| `chassisLength` | (0, 6] m | Longitudinal extent of the chassis box. |
| `chassisWidth` | (0, 3] m | Lateral extent. |
| `chassisHeight` | (0, 2] m | Vertical extent. |
| `fairingStyle` | `bare` \| `swept` \| `full` | Visual fairing variant from the kit. |
| `thrusterCount` | 1–4 | Number of thrusters mounted under the chassis. |
| `thrusterSpacing` | [0, 2] m | Lateral spacing between thrusters. 0 stacks them at center. |
| `fork` | `single` \| `dual` | Front fork visual variant. |

### `physics`

| Field | Range | Notes |
|---|---|---|
| `massKg` | (0, 1000] kg | Rapier rigid-body mass. |
| `topSpeedMps` | (0, 200] m/s | Soft cap on forward speed. |
| `hoverHeight` | (0, 4] m | Target ride height above the surface. |

::: tip Bike stats vs. variant stats
The spec's `physics` block is what the **GLB asset** carries. Sim-side handling (turn torque, accel, lateral drag, surface follow, hover spring/damp, boostMul) lives in the **variant** wired up at [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts). Today the spec is the source of truth for `mass`, `topSpeed`, and `hoverHeight` only — everything else is per-variant in code.
:::

### `appearance`

| Field | Format | Notes |
|---|---|---|
| `liveryColor` | `#RRGGBB` | Primary chassis paint. |
| `metalColor` | `#RRGGBB` | Secondary metallic surfaces. |
| `glowColor` | `#RRGGBB` | Emissive parts (thrusters, taillight). |
| `glowIntensity` | [0, 8] | Multiplier on the emissive material. 1 is mild, 4+ is bloom-territory. |

### `rider`

| Field | Notes |
|---|---|
| `seatOffset` | `[x, y, z]` in bike-root local space (Y up, +Z forward). Where the rider mesh attaches. |

## What the GLB ends up containing

The headless builder produces:

- A `bike_root` empty with `extras = { kind: "bike", id, mass, topSpeed, hoverHeight }`.
- Visual meshes (chassis, fairing, thrusters, fork) parented under it.
- Five **sockets** — `seat`, `nose_cam`, `fx_thruster_l`, `fx_thruster_r`, `fx_exhaust` — each an empty with `extras = { kind: "socket", slot: <name> }`.
- One `collider_body` empty with `extras = { kind: "collider", shape: "box", half_extents: [hx, hy, hz] }` already in three.js axes (right, up, forward).

The runtime path that consumes this is [`src/game/assets/bike-loader.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/assets/bike-loader.ts).

## Wiring into the Garage menu

Open [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts) and add an entry:

```ts
export const BIKE_VARIANTS: Record<BikeVariantId, BikeVariant> = {
  // …existing variants…
  falcon: {
    id: 'falcon',
    name: 'Falcon',
    tagline: 'Glass-cannon — top speed for top-speed sake',
    bodyColor: 0xff3300,
    accentColor: 0xffcc44,
    stats: withDefaults({
      mass: 100,
      accel: 24,
      topSpeed: 34,
      turnTorque: 4.0,
      surfaceFollow: 0.4,
    }),
  },
}
```

Then update the `BikeVariantId` union in the same file. The Garage menu populates from `BIKE_VARIANTS` at boot.

## In-game bike viewer

To eyeball a built bike in isolation — handy for verifying the kit and the in-game render line up — open `?viewer=<bikeId>`:

```
http://localhost:5191/?viewer=scout
http://localhost:5191/?viewer=cruiser
http://localhost:5191/?viewer=1          # first manifest entry
```

The viewer loads the bike GLB, drops it on a grid, and gives you `OrbitControls`. The HUD panel (top-left) shows the bike's id, mass, top speed, hover height, world bbox, livery/metal/glow swatches, every socket, and a quick-switch row to flip between bikes without reloading. Sockets render as small green dots; the box collider renders as an orange wireframe — both invisible in normal gameplay. The viewer skips the entire game boot (no track, physics, AI, audio), so it's a pure render of what `bike-loader.ts` produces.

## Re-authoring kit geometry

If you need new chassis shapes, fairing styles, or thruster meshes, edit `tools/blender/lib/bike_parts.blend` directly. Saving the `.blend` triggers a rebuild of every bike against the new kit. To start from a clean placeholder, re-run `tools/blender/seed_bike_kit.py`.

The kit's outliner is organized into collections that mirror the in-game `?viewer=<id>` page. Flick a collection visible to switch which bike you're previewing:

```
Source                        ← canonical parts (hidden by default)
Bike: Calibration Bike        ← preview (hidden)
Bike: Cruiser                 ← preview (hidden)
Bike: Racer                   ← preview (hidden)
Bike: Scout                   ← preview (visible by default)
Bike: Stunt                   ← preview (hidden)
```

Each `Bike: <name>` collection contains *linked-data instances* of the canonical parts, scaled and positioned per the spec at `specs/bikes/<id>.json`. Mesh data is **shared** with the Source collection — edit a mesh once and every preview updates instantly. The materials are scout's livery (the kit's placeholder palette); the build replaces them with spec-driven materials per bike, so livery differences between bikes only show up in `?viewer`, not in the kit.

To **edit a part**, toggle the Source collection on in the outliner. To **add a new variant**, drop a new mesh into Source and update both `seed_bike_kit.py` (so re-seeding includes it) and `build_bike.py` (so the build picks it). To **add a new bike spec**, drop a new `specs/bikes/<id>.json` and re-run the seed — a new `Bike: <name>` collection appears automatically.

Object viewport positions are layout-only — they don't influence the build (`tools/blender/lib_loader.py` resets transforms on append). Mesh edits *do* ride through.

Open `?viewer=scout` in another tab to compare the kit's silhouette against what the runtime ships — they should be the same modulo material differences (the kit uses static placeholder materials; the build creates spec-driven ones).

### Moving an attachment point — no code change

Where the fairing/fork/fin/tail attach to the chassis is controlled by **mount empties** authored in the kit. Inside `bike_parts.blend`, expand `chassis_base` in the outliner and you'll see four small empties parented to it:

| Mount | Controls |
|---|---|
| `mount_fairing` | Where the fairing snaps onto the chassis |
| `mount_fork` | Where the fork attaches at the nose |
| `mount_fin` | Where the front fin marker sits |
| `mount_tail` | Where the rear tail-light sits |

Translate any of those empties in the viewport, save, and re-run `pnpm gen:bikes` (or just save while `pnpm dev` is running). No code change. Mount positions are stored in chassis-local unit-cube space so they scale with `chassisLength` / `chassisWidth` / `chassisHeight` automatically.

To add a brand-new attachment point, author another empty `mount_<your_role>` parented to `chassis_base`, then add a matching `snap_to_mount(part, chassis, "<your_role>")` line in `tools/blender/build_bike.py`. The mount and any optional `anchor` empty on the child part are stripped from the GLB before export by `strip_build_helpers()` — they never ship to the runtime.

::: tip Mounts vs. sockets
**Mounts** (`mount_*`) are *build-time* — they tell the kit assembler where to attach parts. They're stripped before export. **Sockets** (`socket_*`, e.g. `socket_seat`, `socket_nose_cam`, `socket_fx_*`) are *runtime* — they ride into the GLB and the runtime resolves them by name to attach the rider, place the chase camera, etc. Different prefix, different lifecycle.
:::

Thrusters stay parametric — their count and X spacing come from `spec.geometry.thrusterCount` / `thrusterSpacing` and the build code does the math directly.
