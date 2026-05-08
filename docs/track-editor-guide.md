# In-app track editor

The fast path for authoring + iterating a track. Owns gameplay data —
gates, AI spline, pickups, boost pads, start pose. Pair with Blender for
collidable environment geometry (see
[blender-pipeline-guide.md](./blender-pipeline-guide.md)).

## Open the editor

```
http://localhost:5191/?track=<id>&edit=1
```

`<id>` can be:

- An existing JSON track in `public/tracks/<id>.json` — opens for editing.
- A new id (e.g. `?track=mybeach&edit=1`) — opens an empty draft. Hit
  *Save* to write `public/tracks/mybeach.json`.

The two procedural tracks (`lagoon`, `cliffside`) are built in code and
not editable here. Use a JSON id.

## What's shown

- **Water plane** — the world's flat reference at y=0.
- **Gates** as orange transparent goalposts, indexed `cp_NN`.
- **Pickup spawns** as orange spheres.
- **Boost pads** as cyan flat slabs (placement-only — no boost behaviour
  wired into the sim yet).
- **AI spline** as a dotted polyline through blue spheres at each control
  point.

## Tools

| Tool | Hotkey | What it does |
|---|---|---|
| Select | `1` | Click to pick the entity nearest the cursor (within 8m). |
| + Gate | `2` | Click to place a checkpoint at the cursor; auto-indexed. |
| + Pickup | `3` | Click to place a pickup spawn at the cursor. |
| + Boost | `4` | Click to place a boost pad at the cursor. |
| + Spline pt | `5` | Click to append a point to the AI spline. |

After any placement, the new entity is auto-selected so you can drag it
into final position.

## Manipulating

- **Select + drag** — click an entity, hold the mouse button, drag along
  the ground plane.
- **Delete / Backspace** — remove the selected entity. (The last 2 spline
  points and the gates are protected from leaving the spline empty.)
- **Right-drag** — orbit the camera.
- **Middle-drag** — pan.
- **Wheel** — zoom.

## Save & play

- **Save** — POSTs the current draft to the dev server, which writes
  `public/tracks/<id>.json`. The file is the source of truth (commit it).
- **Play** — reloads the page without `?edit=1`, so you immediately race
  on the latest layout. Hit Backspace if the bike spawns badly while you
  iterate on a draft.
- **Ctrl/Cmd + S** — save shortcut.

## Wiring the env .glb

Set `environmentGlb` in the JSON file to the public URL of your Blender
export. Example for `public/tracks/mybeach.json`:

```json
{
  "id": "mybeach",
  "environmentGlb": "/assets/tracks/mybeach.glb",
  ...
}
```

In editor mode the .glb is **not** loaded (so you can author against the
flat water plane without parallax distractions). It loads on Play.

## Limitations (phase 1)

- **No yaw editing** for gates / pads in the UI yet — drop in, save, hand-
  edit `rotation` in the JSON, or wait for phase 2.
- **No undo.** The Save button is the commit point; reload the page to
  abandon a session's edits.
- **No diff vs. saved.** Save status appears under the Save button; the
  underlying file isn't watched for outside changes.
- **Boost pads have no runtime effect yet.** They render and persist but
  the sim doesn't react. Wiring the speed-up effect is its own task.

These are the next things to build.
