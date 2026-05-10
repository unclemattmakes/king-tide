# Asset pipeline plan — vehicles, props, tracks, riders

> **Status:** historical design brief. The pipeline shipped in M9.27 and
> matches this plan for **props** and **tracks**. The **bike** half was
> flipped in M9.39 to a per-variant `.blend` flow that doesn't match the
> spec-driven kit-assembly described below — author each bike directly
> in `bikes-src/<id>.blend` and click *Hoverbike → Export Bike to Game*.
> The current bike authoring guide is
> [`docs/asset-pipeline-guide.md`](./asset-pipeline-guide.md#bikes-bikes-srcidblend--specsbikesidjson)
> and [`docs-site/modding/bikes.md`](../docs-site/modding/bikes.md).
> The bike-specific sections of this plan (the kit, the mounts, the
> `geometry.*` spec block, `chassisVariant`) are kept here for
> historical context but no longer reflect the runtime pipeline.

> **Original status (M9.27):** proposal, not implemented. This document
> is the brief for a Claude Code instance to execute. It extends the
> existing track pipeline
> ([blender-pipeline-guide.md](./blender-pipeline-guide.md),
> [blender-conventions.md](./blender-conventions.md)) to cover the rest
> of the game's asset categories with a consistent, spec-driven,
> headless-first workflow.

## 1. Goal

Stand up a single, opinionated pipeline that takes us from "edit a JSON
spec" to "GLB rendered in the running game" for every art-bearing entity
in Hoverbike — **vehicles (hoverbikes), props, tracks, and rigged
riders** — without any human ever needing to open Blender for the
*production* path. Blender is reserved for *craft* work (sculpting kit
parts, dialing materials, rigging riders); everything downstream of that
is a deterministic build step driven by JSON specs.

The non-goals, called out so the Claude Code instance doesn't drift:

- Not building actual final art. The pipeline ships with placeholder
  geometry; replacing placeholders with real kit parts is a separate
  effort run iteratively in Blender (with the MCP, optionally).
- Not replacing the in-app track editor. Gameplay placement (gates,
  splines, pickups) stays in the editor. The pipeline owns *geometry*
  and *parameters*, not gameplay.
- Not changing the runtime contract. `extras.kind` remains the
  Blender↔runtime contract.
- Not introducing a new UI for editing bike specs. JSON for now; the
  in-app editor *may* gain an asset-spec panel later, but that's
  deliberately out of scope.

## 2. Current-state assessment

What's good and stays:

- **Track pipeline architecture.** JSON+GLB split, in-app editor for
  gameplay data, Blender for environment geometry. Clean separation,
  well-documented. Don't touch.
- **`tools/export_track.py`.** Validation + NURBS baking + GLB export.
  Solid, reusable. Generalize it slightly so other categories can share
  the validation+export plumbing, but keep its track-side behaviour.
- **Conventions: `extras.kind`, name patterns, custom properties,
  Y-up + 1u=1m + `+Z forward`.** Inherit verbatim.
- **`tracks-src/calibration.blend` as a smoke-test fixture.** Same idea
  is useful for vehicles ("calibration bike"), riders ("calibration
  rider"). Pattern works, copy it.

What's missing and needs to be built:

- No vehicle authoring path. Bikes today are presumably code-built (see
  cliffside as the analog). We need parametric, spec-driven hoverbike
  geometry so we can produce variants cheaply.
- No prop library or scatter system. Tracks reference an environment
  GLB but there's no kitbash inventory feeding it.
- No rigged-character path at all. Riders, animations, ragdolls — none
  of it.
- No spec layer. Every existing Blender asset is a hand-authored
  `.blend`. No way to say "regenerate scout bike with longer chassis"
  without opening Blender.
- No asset manifest. Runtime and editor have no way to enumerate "what
  bikes / props / riders exist?" — every consumer hard-codes lists.
- No watch / hot-rebuild loop. `pnpm dev` doesn't know assets exist.

What I'd retire (with the Claude Code instance flagging for human review
before deletion):

- **`tools/build_calibration_scene.py`** in its current form. The
  pattern is right (programmatic scene construction) but it's bespoke.
  Replace with a generator-driven calibration scene built from
  `specs/tracks/calibration.json` once the generator exists.
- **The all-in-glb track ingestion path** is already labelled "legacy"
  in `blender-conventions.md`. Leave it working but stop investing in
  it; new tracks use the JSON+GLB split.

## 3. Architecture overview

Four asset categories, three layers, one contract.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     A U T H O R I N G   ( h u m a n )               │
│                                                                     │
│  Blender   ←────  craft (sculpt parts, paint materials, rig)        │
│    │             outputs: tools/blender/lib/*.blend                 │
│    │                                                                │
│  JSON specs  ←── parameter editing                                  │
│    │             specs/{bikes,props,riders,tracks}/*.json           │
└────┼────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      B U I L D   ( h e a d l e s s )                │
│                                                                     │
│  blender --background --python tools/blender/build_<category>.py    │
│    │  reads spec, appends parts from lib/, applies parameters,      │
│    │  validates against the kind/extras contract, exports GLB       │
│    ▼                                                                │
│  public/assets/<category>/<id>.glb                                  │
│  public/assets/manifest.json   (regenerated at end of build)        │
└─────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       R U N T I M E   ( g a m e )                   │
│                                                                     │
│  src/game/assets/manifest.ts  — typed view of manifest.json         │
│  src/engine/render/glb-*.ts   — loaders per category                │
│  In-app editor — references assets by id from the manifest         │
└─────────────────────────────────────────────────────────────────────┘
```

The contract everything routes through is **glTF `extras` per node**,
keyed by `kind`, with a small additional vocabulary of `socket_*`,
`collider_*`, and category-specific extras (`half_width` for gates,
`thruster_count` for bikes, etc.). Same idea as today, just extended.

## 4. Directory layout

```
hoverbike/
├── docs/
│   ├── asset-pipeline-plan.md            ← this file
│   ├── asset-pipeline-guide.md           ← (new) end-to-end author guide
│   ├── blender-conventions.md            ← extended: bikes, props, riders
│   ├── blender-pipeline-guide.md         ← unchanged for tracks
│   └── …
│
├── specs/                                ← (new) JSON specs per asset
│   ├── bikes/
│   │   ├── scout.json
│   │   ├── hauler.json
│   │   └── calibration.json              ← smoke-test fixture
│   ├── props/
│   │   ├── barrier_low.json
│   │   ├── lamppost.json
│   │   └── …
│   ├── riders/
│   │   ├── pilot_a.json
│   │   └── calibration.json
│   └── tracks/
│       └── calibration.json              ← replaces build_calibration_scene.py
│
├── tools/
│   ├── README.md                         ← updated table-of-contents
│   ├── export_track.py                   ← KEEP as track-specific exporter
│   ├── snapshot_lagoon.mjs               ← KEEP, unchanged
│   └── blender/                          ← (new) shared Blender pipeline
│       ├── __init__.py
│       ├── common.py                     ← scene reset, GLB export, validation
│       ├── lib_loader.py                 ← appends from lib/*.blend by name
│       ├── sockets.py                    ← socket empty creation/validation
│       ├── colliders.py                  ← primitive + trimesh collider gen
│       ├── build_bike.py                 ← spec.json → bike.glb
│       ├── build_prop.py                 ← spec.json → prop.glb
│       ├── build_rider.py                ← Mixamo .fbx + spec.json → rider.glb
│       ├── build_track.py                ← spec.json → track.glb (replaces calibration script)
│       ├── build_all.py                  ← iterates specs/, runs each builder
│       └── lib/                          ← kitbash .blend libraries
│           ├── bike_parts.blend          ← chassis, fairings, thrusters
│           ├── prop_kit.blend            ← barriers, lampposts, debris
│           └── rider_kit.blend           ← helmet variants, jackets
│
├── tracks-src/                           ← KEEP for hand-authored tracks
│   └── calibration.blend                 ← regenerated from spec post-migration
│
├── public/
│   └── assets/
│       ├── manifest.json                 ← (new) generated, gitignored
│       ├── bikes/                        ← (new) generated GLBs
│       ├── props/                        ← (new) generated GLBs
│       ├── riders/                       ← (new) generated GLBs
│       └── tracks/                       ← unchanged
│
└── src/
    └── game/
        └── assets/                       ← (new)
            ├── manifest.ts               ← typed manifest reader
            ├── bike-loader.ts            ← GLB → runtime bike
            ├── prop-loader.ts            ← GLB → runtime prop instance
            ├── rider-loader.ts           ← GLB → SkeletonHelper-ready rider
            └── socket.ts                 ← shared "find empty named X" helper
```

Two principles in this layout:

- **`specs/` is the source of truth** for any asset whose shape is
  parametric. Editing the JSON and re-running the builder is the
  primary iteration loop. `.blend` files in `tools/blender/lib/` are
  raw kit material — geometry only, no instances.
- **`public/assets/` is generated output** and should be gitignored
  except for any one-off hand-authored asset (e.g. a hero cinematic
  bike). Generated GLBs are reproducible from specs + lib.

## 5. Conventions

Inherit everything from `blender-conventions.md` and extend.

### Units, axes, scale

Unchanged. 1 unit = 1m, Y-up at export, +Z forward. Bike length ≈ 2.5m,
gate width ≈ 28m, rider height ≈ 1.8m.

### Naming

Existing patterns stay (`cp_NN`, `ai_spline_*`, `mat_track_*`,
`water_volume_*`, `start_NN`, `pickup_*`). Add:

| Pattern | Type | Purpose |
|---|---|---|
| `bike_root` | empty | Root transform for a bike GLB. Always at origin. |
| `bike_body` | mesh | Visual chassis mesh. |
| `bike_fx_*` | empty | FX attach points (thruster glow, exhaust, dust emitters). |
| `prop_root` | empty | Root for a prop GLB. |
| `prop_body` | mesh | Prop visual mesh. |
| `rider_root` | empty | Root for a rider GLB. Origin is between feet. |
| `rider_armature` | armature | Skeleton (Mixamo-imported). |
| `socket_*` | empty | Attach point. Required `kind="socket"`, `slot=<name>`. |
| `collider_*` | mesh | Hidden collider geometry. Required `kind="collider"`, `shape`. |
| `mat_bike_*` | material | Bike materials (livery, glow, metal). |
| `mat_prop_*` | material | Prop materials. |
| `mat_rider_*` | material | Rider materials. |

### Sockets

Empties named `socket_<slot>` with `kind="socket"` and a `slot` extra
identifying their semantic role. Standard slots:

| GLB type | Required sockets |
|---|---|
| Bike | `seat` (where rider parents), `nose_cam` (chase-cam target), `fx_thruster_l`, `fx_thruster_r`, `fx_exhaust` |
| Rider | `seat_anchor` (the bone or empty matching `bike.seat`) |
| Prop (lamppost/barrier) | `light_emitter` (optional, only if the prop emits) |

Runtime convention: `bike.getObjectByName('socket_seat')` resolves to a
zero-rotation Object3D the rider gets `.add()`ed into. Same idea as the
existing track checkpoint orientation convention.

### Colliders

Three strategies, picked per category:

- **Primitive (preferred for vehicles + small props).** A `collider_*`
  empty whose `extras` carry `{ kind: "collider", shape: "box" |
  "capsule" | "cylinder" | "sphere", half_extents | radius | height }`.
  No mesh data — Rapier reads the extras and builds the shape directly.
  Compact, fast, ECS-friendly.
- **Convex hull (preferred for hand-sculpted props with non-trivial
  silhouette).** A hidden mesh named `collider_hull`, `kind="collider"`,
  `shape="convex"`. Geometry exported, runtime hands it to Rapier as a
  `ColliderDesc.convexHull`.
- **Trimesh (tracks only, status-quo).** Existing `kind="track"` meshes
  on track .glbs continue to be registered as static trimeshes. No
  change.

The builders enforce that every bike and prop GLB has at least one
`collider_*` node before export.

### Materials

Material names are role-prefixed: `mat_bike_<bike_id>_<role>` (e.g.
`mat_bike_scout_chassis`). Builders rename materials at export so kit
parts pulled from `bike_parts.blend` get assets-specific names — this
prevents shared-material drift across variants. Material *parameters*
(base color, emissive intensity) are spec-driven and applied
post-append.

### Extras carried per node (cheat sheet)

| Node | `kind` | Other extras |
|---|---|---|
| `bike_root` | `bike` | `bike_id`, `mass_kg`, `top_speed_mps` |
| `bike_body` | (no kind) | — (visual only) |
| `prop_root` | `prop` | `prop_id`, `category` |
| `rider_root` | `rider` | `rider_id`, `mixamo_source` |
| `socket_*` | `socket` | `slot` |
| `collider_*` | `collider` | `shape`, `half_extents` \| `radius` \| `height` |

The runtime loaders resolve nodes by `kind`. The validator script
asserts the per-category required set.

## 6. Spec format

JSON Schemas live in `specs/_schema/`. Validators run before the Blender
build step so authors get fast feedback without spinning up Blender.

### Bike spec — `specs/bikes/scout.json`

```jsonc
{
  "$schema": "../_schema/bike.json",
  "id": "scout",
  "displayName": "Scout",
  "geometry": {
    "chassisLength": 2.5,
    "chassisWidth": 0.6,
    "chassisHeight": 0.4,
    "fairingStyle": "swept",          // enum: bare | swept | full
    "thrusterCount": 2,                // 1–4
    "thrusterSpacing": 0.4,
    "fork": "single"                   // enum: single | dual
  },
  "physics": {
    "massKg": 220,
    "topSpeedMps": 65,
    "hoverHeight": 0.8
  },
  "appearance": {
    "liveryColor": "#ff6633",
    "metalColor": "#222428",
    "glowColor": "#5cf2ff",
    "glowIntensity": 1.4
  },
  "rider": {
    "seatOffset": [0, 0.55, -0.1]      // in bike-root local space
  }
}
```

### Prop spec — `specs/props/barrier_low.json`

```jsonc
{
  "$schema": "../_schema/prop.json",
  "id": "barrier_low",
  "displayName": "Low Barrier",
  "category": "barrier",
  "geometry": {
    "kitPart": "barrier_a",            // name of object in prop_kit.blend
    "scale": [1, 1, 1],
    "tint": "#444"
  },
  "collider": {
    "shape": "box",
    "halfExtents": [1.0, 0.5, 0.2]
  }
}
```

### Rider spec — `specs/riders/pilot_a.json`

```jsonc
{
  "$schema": "../_schema/rider.json",
  "id": "pilot_a",
  "displayName": "Pilot A",
  "source": {
    "mixamoFbx": "tools/blender/lib/mixamo/pilot_a.fbx",
    "animations": ["idle", "lean_left", "lean_right", "brake"]
  },
  "appearance": {
    "helmetColor": "#101418",
    "jacketColor": "#3a4250",
    "visorEmissive": "#5cf2ff"
  },
  "rig": {
    "seatBone": "mixamorig:Hips",      // bone aligned to bike socket_seat
    "ragdoll": true                     // generate Rapier ragdoll spec on export
  }
}
```

### Track spec — `specs/tracks/calibration.json`

Replacement for `build_calibration_scene.py`. Same outputs, but
declarative:

```jsonc
{
  "$schema": "../_schema/track.json",
  "id": "calibration",
  "displayName": "Calibration",
  "surface": { "size": [12, 18] },
  "water": { "extents": [40, 40, 4], "waveHeight": 1.0, "waveFreq": 0.5 },
  "checkpoints": [
    { "y": -6, "halfWidth": 4, "height": 2 },
    { "y": -2, "halfWidth": 4, "height": 2 },
    { "y":  2, "halfWidth": 4, "height": 2 },
    { "y":  6, "halfWidth": 4, "height": 2 }
  ],
  "aiSpline": [[0,-8,0.5],[0,-4,0.5],[0,0,0.5],[0,4,0.5],[0,8,0.5]],
  "starts": [[-1,-10,0.5],[1,-10,0.5]],
  "pickups": [[0,0,1.0]]
}
```

## 7. Generators (Blender headless scripts)

All generators share `tools/blender/common.py`:

- `reset_scene()` — wipe defaults (lifted from existing
  `build_calibration_scene.py`).
- `read_spec(env_var)` — read `HOVERBIKE_SPEC` env var, parse JSON,
  validate against schema (use `jsonschema` if available; fall back to
  hand-rolled assertion if not — Blender's bundled Python is minimal).
- `export_glb(out_path, validate_fn)` — runs validator, then exports
  with the same flags as `export_track.py` (export_extras, yup, apply,
  no cameras/lights).
- `apply_extras(obj, **kwargs)` — sets custom properties uniformly.
- `validate_required_kinds(required: dict[str, int])` — asserts the
  scene contains exactly the expected count of each kind.

### `build_bike.py`

```
# Run pattern (called from build_all.py or pnpm script)
HOVERBIKE_SPEC=specs/bikes/scout.json \
HOVERBIKE_OUTPUT=public/assets/bikes/scout.glb \
  blender --background --python tools/blender/build_bike.py
```

Pseudocode:

```
 1. read_spec()
 2. reset_scene()
 3. lib_loader.append_objects(
      "tools/blender/lib/bike_parts.blend",
      ["chassis_base",                                # parent kit part
       "mount_fairing", "mount_fork",                 # build-time attachment empties
       "mount_fin", "mount_tail",                     # parented to chassis_base
       f"fairing_{spec.geometry.fairingStyle}",
       f"fork_{spec.geometry.fork}",
       "fin_marker", "tail_marker", "thruster_unit"],
    )
 4. assemble bike_root (empty); set chassis scale/loc but DON'T bake yet
 5. for each child part:
      snap_to_mount(part, chassis, role)               # reads mount.matrix_world
      apply_transforms(part)                           # bake position into mesh
 6. thrusters: parametric — duplicate per spec.thrusterCount, spread on X
 7. apply spec.appearance to the materials (rename to mat_bike_<id>_*)
 8. add sockets: socket_seat (from spec.rider.seatOffset),
      socket_nose_cam, socket_fx_thruster_{l,r}, socket_fx_exhaust
 9. add primitive collider_body box from spec.geometry dimensions
10. set bike_root extras: { kind: "bike", bike_id, mass_kg, top_speed_mps }
11. strip_build_helpers()                              # delete mount_* / anchor*
12. apply_transforms(chassis); parent chassis to bike_root
13. validate_required_kinds({ "bike": 1, "socket": >=4, "collider": >=1 })
14. export_glb(output_path)
```

> **Mount/anchor system (added post-M9.27):** the original draft of
> this plan put the chassis-relative offsets (fairing at `H+0.15`,
> fork at `nose_y - 0.1`, etc.) inside `build_bike.py` as hardcoded
> math. The current pipeline lifts those positions out of code and
> into kit-side empties — `mount_<role>` parented to the chassis part.
> `tools/blender/mounts.py` provides `snap_to_mount(part, parent,
> role)` and `strip_build_helpers()`. Authors retune attachment points
> by translating an empty in Blender, not by editing pseudocode.
> Variants are *parented* to the mounts so moving a mount drags
> dependent geometry live in the kit. See
> [`asset-pipeline-guide.md`](./asset-pipeline-guide.md#mounts-and-anchors).
>
> **Optional `chassisVariant` (added post-mount-system):** specs may
> set `geometry.chassisVariant: "<name>"` to ship `chassis_<name>`
> from the kit at author-modelled size — no per-spec scaling. The
> default (variant absent) keeps the legacy `chassis_base` cube +
> `(W, L, H)` scale path. `chassisLength`/`Width`/`Height` stay
> required in either case (collider, thruster, fin/tail mount math
> still uses them). Authoring path: open Source in `bike_parts.blend`,
> duplicate `chassis_base` to `chassis_<your_id>`, sculpt to the
> shape you want, set `chassisVariant` in the spec.
>
> **Per-bike preview collections (in-Blender viewer):** the kit
> outliner ships with one `Bike: <name>` collection per spec, each a
> static snapshot built from the matching JSON (linked-data
> instances, mesh data shared with Source). Snapshots refresh on
> re-seed. The runtime equivalent is `?viewer=<id>` — see
> [`src/viewer/bike-viewer.ts`](../src/viewer/bike-viewer.ts).

### `build_prop.py`

Even simpler. Append `kitPart` from `prop_kit.blend`, scale/tint,
attach the spec'd primitive collider, set extras.

### `build_rider.py`

Most complex. Outline:

```
1. read_spec()
2. reset_scene()
3. import Mixamo FBX (bpy.ops.import_scene.fbx)
4. clean up: remove camera/light, normalize armature name to rider_armature,
   normalize root transform so feet are at origin
5. apply spec.appearance to rider materials (rename to mat_rider_<id>_*)
6. import animations from spec.source.animations (either as separate FBX
   takes or as actions on the same armature)
7. add socket_seat_anchor empty parented to the bone in spec.rig.seatBone
8. if spec.rig.ragdoll, walk the armature and emit per-bone collider extras
   (capsules along bone segments, lengths derived from bone.head/tail)
9. set rider_root extras: { kind: "rider", rider_id, mixamo_source }
10. validate
11. export_glb (with export_animations=True, export_skins=True)
```

Mixamo is the cheat code. We don't sculpt rider rigs from scratch; we
upload a base mesh, get a humanoid armature + animation library, FBX
download, and the build script normalizes it.

### `build_track.py`

Replaces `build_calibration_scene.py`. Reads
`specs/tracks/<id>.json`, builds the scene, and either saves a `.blend`
to `tracks-src/<id>.blend` (for human follow-up authoring) or exports
directly to GLB. Two modes via env var. The existing `export_track.py`
is invoked unchanged for the GLB path.

### `build_all.py`

```
for each spec in specs/{bikes,props,riders,tracks}/*.json:
  invoke the appropriate builder via subprocess
  collect successes / failures
write public/assets/manifest.json with metadata for each successful asset
exit non-zero if any builder failed
```

Run sequentially for now (Blender startup is the dominant cost; one
process per asset). Parallelize with `xargs -P` later if it becomes a
bottleneck.

## 8. Library .blend files

Three kit files under `tools/blender/lib/`:

- **`bike_parts.blend`** — named objects: `chassis_base`,
  `fairing_bare`, `fairing_swept`, `fairing_full`, `thruster_unit`,
  `fork_single`, `fork_dual`, `fin_marker`, `tail_marker`. Parts are
  laid out in their assembled-bike positions (chassis at centre,
  fairing on top, fork at the nose, etc.) so authors can edit in
  context — viewport positions are layout-only and `lib_loader.py`
  resets them on append. The chassis carries small `mount_<role>`
  empty children (`mount_fairing`, `mount_fork`, `mount_fin`,
  `mount_tail`) that the build snaps each part to. Materials prefixed
  `mat_kit_bike_*` so the renamer can find them.
- **`prop_kit.blend`** — named objects per spec'd `kitPart` value.
  Start with: `barrier_a`, `barrier_b`, `lamppost_short`,
  `lamppost_tall`, `crate_small`, `crate_large`, `holo_billboard`,
  `pylon`.
- **`rider_kit.blend`** — accessory parts: helmet variants, jacket
  variants, gloves. The Mixamo FBX provides the base body; this kit
  provides swappable accessories that get parented to specific bones.

These files are committed to the repo. They're treated as **source
art** — humans edit them in Blender (with the MCP, optionally), commit
the `.blend`, and every spec that references their parts gets
regenerated.

## 9. Rider rigging — Mixamo workflow

This is the one place where a human + Blender + a third-party service
are unavoidable. The pipeline absorbs the irregularity, but the human
step exists.

For each new rider:

1. Modeller exports a static T-posed mesh from Blender as `.fbx`.
2. Upload to Adobe Mixamo, auto-rig (the wizard takes ~2 min for
   humanoid).
3. Download three FBXs: one **with skin**, then per spec'd animation
   (idle, lean, brake, etc.) **without skin** as separate animation
   takes.
4. Drop the FBX files into `tools/blender/lib/mixamo/<rider_id>/`.
5. Author / edit `specs/riders/<rider_id>.json`.
6. Run `pnpm gen:riders` — `build_rider.py` imports, normalizes,
   re-skins animations to the master armature, applies appearance,
   exports the rider GLB.
7. Runtime loads via `rider-loader.ts`, which uses Three's
   `SkeletonUtils.clone()` for cheap per-bike instances and
   `AnimationMixer` to blend states.

Rider-on-bike at runtime is then `bike.socket_seat.add(rider_clone)`.
The rider's `socket_seat_anchor` is positioned so its parent bone
(`mixamorig:Hips` typically) lines up with the bike seat. Rider lean
animations are local to the rider; the bike does its own physics-driven
roll.

For ragdolls (post-crash), the rider GLB carries per-bone capsule
extras emitted by `build_rider.py`. A runtime helper turns those into
Rapier rigid bodies + revolute joints when the bike's
`crashed` component fires.

## 10. Asset manifest

`public/assets/manifest.json` is the runtime/editor's index of what
exists. Generated by `build_all.py` after successful builds.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-08T...",
  "bikes": [
    {
      "id": "scout",
      "displayName": "Scout",
      "url": "/assets/bikes/scout.glb",
      "specPath": "specs/bikes/scout.json",
      "preview": "/assets/bikes/scout.thumb.png"   // optional, future
    }
  ],
  "props": [...],
  "riders": [...],
  "tracks": [...]
}
```

`src/game/assets/manifest.ts` exports a typed reader. The in-app editor
fetches the manifest at startup so its "Add Bike" / "Add Prop" menus
populate dynamically. No more hard-coded id lists in `main.ts`.

This single change — a manifest the editor reads — is the highest-ROI
piece for unlocking the editor's potential. Right now adding a new
track requires editing `main.ts`. With the manifest, the editor browses
what's on disk.

## 11. MCP integration (optional)

Stays out of the production path. Recommended setup for *craft*:

- Install `ahujasid/blender-mcp` once on Matt's machine and configure
  it in Claude Desktop. (Plan documents this in
  `docs/asset-pipeline-guide.md`, doesn't automate the install.)
- Use the MCP to: sculpt new kit parts into `bike_parts.blend`,
  iterate prop silhouettes in `prop_kit.blend`, dial materials, eyeball
  rider proportions before sending to Mixamo.
- The MCP **does not** run during `pnpm gen:*`. Headless scripts only.
- Document a "MCP session checklist" in the guide: don't commit
  unsaved kit files, run `pnpm gen:bikes` after editing kit to
  regenerate downstream GLBs.

The official Blender Foundation MCP server (Q1 2026, maturing fast) is
worth re-evaluating in 6 months. The plan's contracts (file-based,
extras-driven) are MCP-agnostic — switching MCPs doesn't affect any
script in `tools/blender/`.

## 12. Build wiring

### `package.json` scripts

```jsonc
{
  "scripts": {
    "gen:bikes": "node tools/blender/run.mjs build_bike specs/bikes",
    "gen:props": "node tools/blender/run.mjs build_prop specs/props",
    "gen:riders": "node tools/blender/run.mjs build_rider specs/riders",
    "gen:tracks": "node tools/blender/run.mjs build_track specs/tracks",
    "gen:all": "node tools/blender/run.mjs build_all",
    "gen:manifest": "node tools/blender/run.mjs manifest"
  }
}
```

`tools/blender/run.mjs` is a thin Node wrapper that:

- Resolves the Blender executable cross-platform (PATH first, then
  Windows default `C:\Program Files\Blender Foundation\Blender 5.x\`,
  then macOS `/Applications/Blender.app/...`, then errors with a
  clear message pointing to the install guide).
- Iterates spec files and invokes Blender per file with the right env
  vars (`HOVERBIKE_SPEC`, `HOVERBIKE_OUTPUT`).
- Streams Blender's stdout/stderr to the console with a category
  prefix so failures are easy to spot.
- Exits non-zero on any builder failure.

### Watch mode (optional, phase 2)

A Vite plugin watches `specs/**/*.json` and `tools/blender/lib/**/*.blend`,
debounces, and triggers the appropriate `gen:*` script. Outputs in
`public/assets/` are picked up by Vite's normal asset handling, so HMR
just works once a GLB is regenerated.

### CI

GitHub Actions job runs `pnpm gen:all` on PRs that touch `specs/` or
`tools/blender/`. Cache the Blender install. Upload the resulting
manifest as a build artifact. Fail PRs whose specs don't validate.

## 13. In-app editor integration

The editor today knows about gates, splines, pickups, and boost pads —
all *gameplay* primitives. After this pipeline lands, the editor also
knows about *asset instances*: "place a `bike:scout` here," "place a
`prop:lamppost_tall` along this stretch."

Concrete editor changes (out of scope for the pipeline implementation,
but the pipeline must enable them):

- **Asset palette** populated from `manifest.json`. New buttons:
  *+ Bike*, *+ Prop*, *+ Rider*. Arming places the asset on next ground
  click.
- **Asset instance JSON** stored on the track JSON:
  ```json
  "props": [
    { "assetId": "lamppost_tall", "position": [...], "rotation": [...] }
  ]
  ```
- **Spec parameter editor (future, Phase 4).** A panel that, when an
  asset instance is selected, lets you tweak that asset's spec inline
  and writes a track-local override to the JSON. Useful for "this
  particular barrier is red." Out of scope until manifest + placement
  ship.

## 14. Migration plan — phased

Each phase is independently shippable. Stop after any phase if priorities
shift.

**Phase 0 — preserve.** Do nothing destructive. `tools/export_track.py`
keeps working. The existing track pipeline is untouched. *Acceptance:
`pnpm dev` still loads `?track=cliffside` and `?track=calibration`.*

**Phase 1 — bikes.** Stand up `tools/blender/{common,build_bike}.py`,
`tools/blender/lib/bike_parts.blend` (with placeholder geometry — a
chassis cube, three fairing variants, a thruster cylinder), the
`scout.json` and `calibration.json` bike specs, the `pnpm gen:bikes`
script, and `src/game/assets/bike-loader.ts`. Wire the running game to
load `scout.glb` for the player bike. *Acceptance: a bike GLB renders
in-game, regenerable from spec.*

**Phase 2 — manifest + props.** Add `build_all.py`,
`public/assets/manifest.json`, `src/game/assets/manifest.ts`. Stand up
`build_prop.py` and `prop_kit.blend` with five placeholder props. Add
editor *+ Prop* button populated from the manifest. *Acceptance:
placing a prop in the editor and saving emits a track JSON the runtime
loads.*

**Phase 3 — riders.** Wire `build_rider.py`, document the Mixamo flow,
ship one `pilot_a` rider attached to the player bike via
`socket_seat`. Lean animation states. *Acceptance: rider visible on
bike, animates idle/lean during play.*

**Phase 4 — track spec migration.** Rewrite
`build_calibration_scene.py` as `build_track.py` driven by
`specs/tracks/calibration.json`. Verify the resulting `.blend` matches
the existing one byte-for-byte (or close enough that `export_track.py`
output matches). Retire the old script. *Acceptance: existing
calibration smoke test still passes; old script deleted.*

**Phase 5 — polish.** Vite watch plugin, CI step, ragdoll generation,
spec parameter editor in the in-app editor. Each is its own task,
order to taste.

## 15. What we keep / replace / deprecate

Explicit table for the Claude Code instance:

| Existing artefact | Action | Notes |
|---|---|---|
| `tools/export_track.py` | **Keep.** | Generalize lightly: factor the GLB-export call into `tools/blender/common.py` so other builders share it. Keep the validation rules track-specific (they live in this script). |
| `tools/build_calibration_scene.py` | **Replace in Phase 4.** | Rewrite as `tools/blender/build_track.py` driven by `specs/tracks/calibration.json`. Delete the old script when the new one passes the smoke test. |
| `tools/snapshot_lagoon.mjs` | **Keep, unchanged.** | Unrelated to the asset pipeline. |
| `tracks-src/calibration.blend` | **Keep, regenerate.** | After Phase 4, this is regenerated by `build_track.py` from the spec. |
| `docs/blender-conventions.md` | **Extend.** | Add bike/prop/rider/socket/collider sections. Keep the existing track table as-is. |
| `docs/blender-pipeline-guide.md` | **Keep.** | Track-specific. Cross-link to the new asset-pipeline-guide. |
| `docs/track-editor-guide.md` | **Extend in Phase 2+.** | Add asset-placement sections once the editor consumes the manifest. |
| Hard-coded track id list in `src/main.ts` | **Replace in Phase 2.** | Read from `manifest.json` via `manifest.ts`. |
| `public/assets/tracks/*.glb` | **Keep.** | Same path; tracks remain the established category. |

## 16. Implementation task list — for the Claude Code instance

These are ordered, atomic, and each has an acceptance criterion. The
instance should mark each complete before moving on. **Do not skip the
acceptance steps**; they're how we know the pipeline actually works
end-to-end.

### Pre-flight (do these first)

**T0.** Read this entire document. Read `docs/blender-conventions.md`,
`docs/blender-pipeline-guide.md`, `docs/track-editor-guide.md`,
`tools/export_track.py`, `tools/build_calibration_scene.py`. Confirm
back to Matt that you understand the existing pipeline before changing
anything.

**T1.** Run `pnpm dev` and load `?track=calibration` and
`?track=cliffside`. Confirm both work today. Take a screenshot of each
for the "before" state. *Acceptance: both tracks load and render.*

### Phase 1 — bikes

**T2.** Create `tools/blender/{__init__.py,common.py,sockets.py,colliders.py,lib_loader.py}`.
`common.py` exposes `reset_scene`, `read_spec`, `export_glb`,
`apply_extras`, `validate_required_kinds`. *Acceptance: importable from
a smoke-test script.*

**T3.** Create `tools/blender/lib/bike_parts.blend` programmatically
via a one-shot script `tools/blender/seed_bike_kit.py` that builds
placeholder geometry (chassis cube, three fairing variants as scaled
boxes, thruster cylinder, two fork variants). Run it, commit the
`.blend`. Document the seed script as the way to rebuild the kit.
*Acceptance: file exists, opens in Blender, contains the named objects.*

**T4.** Create `specs/_schema/bike.json` JSON Schema and
`specs/bikes/{scout.json, calibration.json}` matching the schema.
*Acceptance: both validate against the schema with `ajv` (added as a
dev dep).*

**T5.** Implement `tools/blender/build_bike.py` per the pseudocode in
§7. *Acceptance: running `HOVERBIKE_SPEC=specs/bikes/scout.json
HOVERBIKE_OUTPUT=public/assets/bikes/scout.glb blender --background
--python tools/blender/build_bike.py` writes a GLB.*

**T6.** Inspect the GLB in `https://gltf-viewer.donmccurdy.com/` (or
any viewer). Confirm `bike_root.extras.kind === "bike"`, sockets
present, collider present. *Acceptance: screenshots / extras dump
captured.*

**T7.** Add `tools/blender/run.mjs` Node wrapper with cross-platform
Blender resolution. Add `pnpm gen:bikes` script. *Acceptance:
`pnpm gen:bikes` regenerates all bike GLBs without typing `blender`
manually.*

**T8.** Implement `src/game/assets/bike-loader.ts` (loads GLB, resolves
sockets by name, returns a typed `LoadedBike` with `root`, `sockets`,
`colliders`, `extras`). Wire the player bike in `src/main.ts` to use
`scout.glb` instead of whatever it uses today (likely a code-built
mesh). *Acceptance: `pnpm dev` shows the loaded bike GLB; player still
controls correctly; collider matches visual.*

**T9.** Add a Vitest unit test for `bike-loader.ts` using a fixture
GLB. *Acceptance: test passes in `pnpm test`.*

### Phase 2 — manifest + props

**T10.** Implement `tools/blender/build_all.py` that iterates specs and
invokes the right builder. *Acceptance: `pnpm gen:all` runs every
builder once and reports per-asset success/failure.*

**T11.** Have `build_all.py` write `public/assets/manifest.json` per
§10. Add `public/assets/manifest.json` to gitignore;
`public/assets/{bikes,props,riders}/*.glb` too. *Acceptance: manifest
exists after `pnpm gen:all`, has the expected shape.*

**T12.** Implement `src/game/assets/manifest.ts` typed reader. Replace
the hard-coded track id list in `src/main.ts` with manifest-driven
resolution. *Acceptance: `?track=<any-track-in-manifest>` works without
touching `main.ts`.*

**T13.** Seed `tools/blender/lib/prop_kit.blend` with 5 placeholder
props (same approach as T3). Author 5 `specs/props/*.json`. Implement
`build_prop.py`. *Acceptance: `pnpm gen:props` produces 5 prop GLBs.*

**T14.** Add `+ Prop` button to the in-app editor; populate from
manifest; place clicked prop in track JSON. Render placed props in
both editor and play modes. *Acceptance: place a barrier in the
editor, save, reload, barrier visible in play.*

### Phase 3 — riders

**T15.** Document the Mixamo workflow in
`docs/asset-pipeline-guide.md` (new file). *Acceptance: a non-author
can follow it end-to-end.*

**T16.** Acquire one Mixamo rider FBX (Matt does this; Claude Code
documents the exact steps to take). Drop into
`tools/blender/lib/mixamo/pilot_a/`. *Acceptance: FBX present, paths
match spec.*

**T17.** Implement `build_rider.py` and `specs/riders/pilot_a.json`.
*Acceptance: `pnpm gen:riders` produces `pilot_a.glb` with armature,
animations, and seat anchor.*

**T18.** Implement `src/game/assets/rider-loader.ts` using
`SkeletonUtils.clone()` and `AnimationMixer`. Attach the rider to the
player bike's `socket_seat`. *Acceptance: rider visible on bike during
play, idle animation runs.*

### Phase 4 — track spec migration

**T19.** Implement `build_track.py` driven by
`specs/tracks/calibration.json`. Output mode A: write
`tracks-src/<id>.blend`. Output mode B: invoke `export_track.py`
internally to write the GLB directly. *Acceptance: regenerated
calibration GLB byte-equivalent (or visually equivalent) to the
current one; existing smoke test still passes.*

**T20.** Delete `tools/build_calibration_scene.py`. Update
`tools/README.md` and `docs/blender-pipeline-guide.md` to reference
the new builder. *Acceptance: no stale references remain;
`grep -r build_calibration_scene` returns nothing.*

### Phase 5 — polish (do these only if Phase 1-4 ship cleanly)

**T21.** Vite plugin: watch `specs/` + `tools/blender/lib/`, trigger
`gen:*` on change, hot-reload affected GLBs.

**T22.** GitHub Actions workflow: `pnpm gen:all` on PRs touching
`specs/` or `tools/blender/`.

**T23.** Ragdoll spec generation in `build_rider.py` + Rapier ragdoll
runtime helper.

**T24.** In-app spec parameter override panel (per-asset-instance
inline tweaks to `liveryColor` etc.).

## 17. Open questions

Things the Claude Code instance should ask Matt before starting, not
guess at:

1. **Player bike today** — is the player bike currently code-built (à
   la cliffside terrain) or is there already a placeholder GLB? T8
   needs to know what it's replacing.
2. **`tools/build_calibration_scene.py` retirement** — Matt said he's
   "not a fan of what we have so far." Is the calibration script
   specifically something to retire, or is it fine and the unhappiness
   is about the *missing* pieces (no bike pipeline etc.)? Plan assumes
   the latter — confirm.
3. **Mixamo licensing** — fine for a solo project; if this game is
   ever commercial, double-check Mixamo's terms (currently free for
   commercial use as of last public statement, but verify before
   shipping).
4. **Blender version pin** — pipeline targets 5.1+ matching existing
   guide. Acceptable?
5. **Asset GLB commit policy** — gitignore generated GLBs (default in
   this plan) or commit them (what tracks do today)? Trade-off:
   gitignored = clean repo, requires running `pnpm gen:all` after
   clone. Committed = clone-and-go, repo bloats. Default is
   gitignore + a one-time-setup `pnpm gen:all` documented in the
   root README.
6. **Manifest schema versioning** — single bump on breaking changes
   acceptable? Or richer migration story needed?

## 18. References

- [`blender-conventions.md`](./blender-conventions.md) — existing
  conventions card to extend.
- [`blender-pipeline-guide.md`](./blender-pipeline-guide.md) —
  existing track-author walkthrough.
- [`track-editor-guide.md`](./track-editor-guide.md) — in-app editor
  workflow.
- [Mixamo](https://www.mixamo.com/) — auto-rigging service.
- [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp) —
  community MCP server for craft work.
- [Blender MCP Server (official)](https://www.blender.org/lab/mcp-server/) —
  Foundation's MCP, maturing.
- [Three.js `SkeletonUtils.clone`](https://threejs.org/docs/#examples/en/utils/SkeletonUtils) —
  cheap rigged-mesh instancing.
