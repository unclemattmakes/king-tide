# Authoring bikes

Each bike variant is a standalone Blender file at `bikes-src/<id>.blend` plus a slim metadata spec at `specs/bikes/<id>.json`. Open the .blend, edit the variant directly, click **Hoverbike → Export Bike to Game** in the addon — the GLB updates and the runtime picks it up on next reload.

There is **no shared kit**: editing `racer.blend` does not propagate to `cruiser.blend`. Each variant is its own scene.

## Quick add

```bash
# 1. Save-as an existing variant
#    File → Save As… → bikes-src/falcon.blend
#    (open Blender on bikes-src/scout.blend, then save-as)

# 2. Edit the variant — sculpt meshes, drag sockets, recolour materials.

# 3. In the 3D viewport: N → Hoverbike tab → Export Bike to Game.
#    The addon validates the scene, writes public/assets/bikes/falcon.glb,
#    and on first export creates a starter specs/bikes/falcon.json.

# 4. Try it in-game
open http://localhost:5191/?bike=falcon
```

To make the new bike selectable from the Garage menu, also wire it into [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts). Otherwise the URL parameter is the only entry.

::: tip Where the bike id comes from
The .blend's filename basename is the id (`bikes-src/falcon.blend` → `falcon`). The addon backfills `bike_root.extras.bike_id` from that filename on first export, but if you ever want the id to differ from the filename, set the scene custom property `hoverbike_bike_id`.
:::

### Headless / CI

`pnpm gen:bikes` opens each `bikes-src/<id>.blend` in `--background` mode, applies any spec overrides, and exports — same output as the addon button, runs without a GUI.

## What the .blend must contain

The validator runs both in the addon (before export) and in `build_bike.py` (before headless export), and rejects the build if any of these are missing:

| Object | Required | Purpose |
|---|---|---|
| `bike_root` (empty) | exactly 1 | Runtime entry node. Must carry `extras.kind="bike"` and `bike_id` (the addon backfills the id from the filename). Optional but recommended extras: `mass_kg`, `top_speed_mps`, `hover_height`, `display_name`. |
| `socket_seat` (empty) | yes | Where the rider parents to the bike. `extras.kind="socket"`, `slot="seat"`. |
| `socket_nose_cam` (empty) | yes | Chase-camera anchor at the nose. `extras.kind="socket"`, `slot="nose_cam"`. |
| `socket_fx_thruster_l` (empty) | yes | Left thruster FX emitter origin. |
| `socket_fx_thruster_r` (empty) | yes | Right thruster FX emitter origin. |
| `socket_fx_exhaust` (empty) | yes | Centre exhaust FX origin. |
| At least one collider (empty) | yes | `extras.kind="collider"`, `shape="box"`, `half_extents=[hx, hy, hz]` in three's axes (right, up, forward). The conventional name is `collider_body`, but only the extras matter. |

Visual meshes are everything else — there's no minimum. The runtime renders any mesh that isn't tagged `kind=collider` or `kind=socket`.

## Naming + parenting (what actually matters)

The runtime walks the GLB by `extras.kind`, **never by name** ([`bike-loader.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/assets/bike-loader.ts)). That means:

| What | Naming matters? | Why |
|---|---|---|
| Mesh objects (`bike_body`, `bike_fairing`, …) | **No** — call them whatever helps you author. | The runtime walks every non-tagged mesh and renders it. The conventional names are just useful for the outliner. |
| `bike_root` empty | Yes (resolved by name + `extras.kind="bike"`). | Runtime entry point. |
| `socket_<slot>` empties | Slot value in extras is what matters; the object name is convenience. | Runtime resolves attach points by `(extras.kind="socket", slot=<slot>)`. |
| Material names | Sometimes — see below. | |

Two material-name conventions do leak into runtime / build behaviour:

- **`_livery` substring** in any material name → that material gets cloned + tinted per-AI-bike at instantiation time, so AI riders show distinct colors without their own GLBs ([`bike-loader.ts:178`](https://github.com/occ-matt/hoverbike/blob/main/src/game/assets/bike-loader.ts)). If you want a part to recolour for AI bikes, give its material a name that includes `_livery`. If not, use any other name.
- **`mat_bike_<bike_id>_{chassis,livery,glow,fork,fin,tail}`** → the headless build's `spec.appearance` overrides find materials by this exact pattern and recolour them. If you don't use the spec's `appearance` block, the pattern is a no-op and you can name materials anything.

### Don't parent geo under sockets

Tempting pattern: parent the thruster mesh under `socket_fx_thruster_l` so moving the socket drags the geo. **Don't** — for two reasons:

1. **Sockets are hidden at clone time.** [`cloneLoadedBike`](https://github.com/occ-matt/hoverbike/blob/main/src/game/assets/bike-loader.ts) sets `visible = false` on every `kind=socket` and `kind=collider` empty. Three.js propagates invisibility down the subtree, so geo parented under a socket never renders in the game. (It would still show up in the bike viewer if you toggle visibility on, but that's a debug surface.)
2. **Socket positions are a runtime contract.** The rider parents at `socket_seat`. The chase camera anchors at `socket_nose_cam`. FX emitters spawn at `socket_fx_*`. If a geo edit silently shifts a socket, you've broken those anchors with no error.

The pattern that gives you the "live attach" feel without the gotchas: **parent the socket under the geo, not the geo under the socket.** Example: `socket_fx_thruster_l` as a child of your `bike_thruster_l` mesh. Move the thruster, the FX socket follows automatically.

For everything else, the simplest layout is flat siblings:

```
bike_root
├── bike_body            (mesh — name doesn't matter)
├── bike_fairing         (mesh)
├── bike_fork            (mesh)
├── bike_thruster_0      (mesh) [optional: socket_fx_thruster_l as child]
├── bike_thruster_1      (mesh) [optional: socket_fx_thruster_r as child]
├── bike_fin             (mesh)
├── bike_tail            (mesh)
├── socket_seat          (empty, kind=socket, slot=seat)
├── socket_nose_cam      (empty, kind=socket, slot=nose_cam)
├── socket_fx_thruster_l (empty, kind=socket, slot=fx_thruster_l)  ← OR child of bike_thruster_0
├── socket_fx_thruster_r (empty, kind=socket, slot=fx_thruster_r)  ← OR child of bike_thruster_1
├── socket_fx_exhaust    (empty, kind=socket, slot=fx_exhaust)
└── collider_body        (empty, kind=collider, shape=box, half_extents=...)
```

## Spec format

```json
{
  "$schema": "../_schema/bike.json",
  "id": "racer",
  "displayName": "Racer",
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
  }
}
```

Both `physics` and `appearance` are optional overlays. Drop them and the build uses whatever `bike_root.extras` and authored materials hold in the .blend.

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable identifier matching `^[a-z][a-z0-9_-]*$`. Becomes the GLB filename. Must match the .blend's basename (or `bike_root.extras.bike_id`, or the scene's `hoverbike_bike_id` custom property). |
| `displayName` | string | yes | Shown in the manifest, the Garage menu, and the bike viewer HUD. |

### `physics` (optional override)

Written into `bike_root` extras at build time so the runtime + viewer HUD see the spec's values without you reopening Blender. If absent, the .blend's authored extras are used unchanged.

| Field | Range | Notes |
|---|---|---|
| `massKg` | (0, 1000] kg | Goes to `bike_root.extras.mass_kg`. |
| `topSpeedMps` | (0, 200] m/s | Goes to `bike_root.extras.top_speed_mps`. |
| `hoverHeight` | (0, 4] m | Goes to `bike_root.extras.hover_height`. |

::: tip Bike stats vs. variant stats
The spec's `physics` and the GLB's extras are surface metadata for the manifest and viewer. **Sim-side handling** (turn torque, accel, lateral drag, surface follow, hover spring/damp, boost multiplier) lives in the **variant** wired up at [`src/game/bikes/variants.ts`](https://github.com/occ-matt/hoverbike/blob/main/src/game/bikes/variants.ts). Editing the spec doesn't change how the bike feels under your hands — change the variant for that.
:::

### `appearance` (optional override)

Recolour overlays applied to materials matching `mat_bike_<id>_<role>` (`<role>` = `chassis`, `livery`, `glow`, `fork`, `fin`, `tail`). If absent, the .blend's authored materials ride through unchanged. Used for the Garage menu's color swatches.

| Field | Format | Notes |
|---|---|---|
| `liveryColor` | `#RRGGBB` | Recolours `mat_bike_<id>_livery` (and `_fin`'s base + emissive). |
| `metalColor` | `#RRGGBB` | Recolours `mat_bike_<id>_chassis` and `_fork`. |
| `glowColor` | `#RRGGBB` | Recolours `mat_bike_<id>_glow`'s base + emissive. |
| `glowIntensity` | [0, 8] | Multiplier on the `_glow` material's emissive strength. |

### Legacy fields (`geometry`, `rider`)

Older specs that predate M9.39 have `geometry` and `rider` blocks. The schema still accepts them for backward compatibility, but the build **ignores** both — geometry lives in the .blend, the seat anchor is `socket_seat`. New specs should omit them.

## What the GLB ships

```
bike_root              (extras: kind=bike, bike_id, mass_kg, top_speed_mps,
                        hover_height, display_name)
├── visible meshes     (cast + receive shadows)
├── socket_*           (extras: kind=socket, slot=<slot>; hidden at runtime)
└── collider_*         (extras: kind=collider, shape=..., half_extents=...;
                        hidden at runtime)
```

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

To eyeball a built bike in isolation — handy for verifying the .blend round-trip — open `?viewer=<bikeId>` (also reachable from the addon's **Copy Viewer URL** button):

```
http://localhost:5191/?viewer=scout
http://localhost:5191/?viewer=cruiser
http://localhost:5191/?viewer=1          # first manifest entry
```

The viewer drops the bike on a grid with `OrbitControls`. The HUD panel (top-left) shows the bike's id, mass, top speed, hover height, world bbox, livery / metal / glow swatches, every socket slot, and a quick-switch row to flip between bikes without reloading. Sockets render as small green dots; the box collider renders as an orange wireframe — both invisible in normal gameplay. The viewer skips the entire game boot (no track, physics, AI, audio), so it's a pure render of what `bike-loader.ts` produces.

## Tips

### Studio lighting in the .blend

The seeder bakes a sun + soft fill into each `bikes-src/<id>.blend` so the in-Blender preview looks like the in-game viewer. The GLB exporter strips lights (`export_lights=False`), so they never reach the runtime — feel free to add more lights to taste.

### Hidden objects are skipped on export

Toggling the eye icon off in the outliner excludes that object from the GLB. Useful for staging WIP geometry next to the live bike without it leaking into the build.

### Materials follow the convention so spec overrides keep working

If you author your own materials, name them `mat_bike_<id>_<role>` (`<role>` ∈ `chassis`, `livery`, `glow`, `fork`, `fin`, `tail`) and the spec's `appearance.*` recolour will keep working. Skip the convention and the spec block becomes a no-op for that material — your authored colour ships as-is.

### Forgetting `kind` on bike_root / sockets / collider

Most authoring mistakes surface as a clear validator error in Blender's status bar. The custom property panel on each empty needs:

- `bike_root` → `kind = "bike"`, `bike_id = "<id>"`.
- Each socket → `kind = "socket"`, `slot = "<slot>"`.
- The collider → `kind = "collider"`, `shape = "box"`, `half_extents = [hx, hy, hz]`.

The seeded variants (`bikes-src/{calibration,cruiser,racer,scout,stunt}.blend`) are the canonical reference — copy a custom-property panel from there if you're unsure.
