# URL parameters

The game accepts query-string parameters at the root URL. They compose freely.

### Race / menu

| Param | Values | Default | Effect |
|---|---|---|---|
| `track` | `lagoon` \| `cliffside` \| `calibration` \| `test-ring` \| any id under `public/tracks/` | `lagoon` | Picks the track. JSON-driven tracks are loaded from `public/tracks/<id>.json`. |
| `bike` | `cruiser` \| `racer` \| `stunt` \| any id under `public/assets/bikes/` | `racer` | Picks the player bike variant. |
| `race` | `1` | off | Boots straight into a race. |
| `autostart` | `1` | off | Starts the race immediately (skips the pre-race wait). |
| `cup` | any cup id | off | Boots into the named cup. |
| `room` | any room id | off | Joins a multiplayer lobby room. Add `&race=1` to skip the lobby and go straight to the race. |
| `tt` | `1` | off | Time-trial / deterministic mode. |
| `replay` | replay data | off | Plays back a recorded replay. |
| `determinism` | `<seed>` | off | Runs with a fixed determinism seed. |
| `tutorial` | `1` | off | Boots into the tutorial. |
| `host` | `<server>` | off | Connects to the named multiplayer server. |
| `back` | `1` | off | Returns to the previous menu/screen. |
| `ai` | `<n>` | full field | Caps the AI field size to `n` opponents. |

### Authoring

| Param | Values | Default | Effect |
|---|---|---|---|
| `edit` | `1` | off | Opens the in-app track editor instead of the racer. Defaults the track to `lagoon-edit` if `track` isn't set. See [Authoring tracks → Editor-driven](/modding/tracks#editor-driven-authoring). |

### Dev scenes

| Param | Values | Default | Effect |
|---|---|---|---|
| `viewer` | any bike id, or `1` for the first manifest entry | off | Opens the stand-alone bike viewer — a turntable with `OrbitControls` for inspecting one built bike GLB. Skips the entire game boot (no track / physics / AI). See [Authoring bikes](/modding/bikes). |
| `propviewer` | `<id>` | off | Opens the prop studio viewer for one prop. |
| `calibrate` | `1` | off | Opens the rider-pose calibration scene. |
| `rideredit` | `1` | off | Opens the rider editor. |
| `waveriders` | `1` | off | Opens the wave-rider validation scene. |
| `waterlab` | `1` | off | Opens the water lab. |
| `watertune` | `<slug>` | off | Opens water tuning for the named track. |
| `podium` | `1` | off | Opens the podium ceremony scene. |

### Tidal / level

| Param | Values | Default | Effect |
|---|---|---|---|
| `tide` | `<amp>[,period[,phase]]` | off | King-Tide tidal-height override (amplitude, optional period and phase). |

### Debug

| Param | Values | Default | Effect |
|---|---|---|---|
| `wavedots` | `1` | off | Visualises water sample points as dots. |
| `wire` | `1` | off | Renders the water surface as wireframe. |
| `clipcollision` | `0` | on | Restores collide-everything (disables the collision-corridor clip). |

## Examples

| URL | What you get |
|---|---|
| `http://localhost:5191/` | Lagoon Loop, Racer bike — default config |
| `http://localhost:5191/?track=cliffside` | Cliffside, Racer bike |
| `http://localhost:5191/?bike=stunt` | Lagoon Loop, Stunt bike |
| `http://localhost:5191/?track=cliffside&bike=stunt` | "The most fun config" per the README |
| `http://localhost:5191/?edit=1` | Track editor over `lagoon-edit` |
| `http://localhost:5191/?track=mybeach&edit=1` | Editor over a specific (or new) JSON track |
| `http://localhost:5191/?viewer=scout` | Stand-alone bike viewer — turntable with orbit controls, inspect one built bike |

## Persistence

URL params are read once at boot. Changing the URL while the game is running has no effect — reload to apply.

The Garage menu (HUD button, top-right) writes the chosen `bike` + `track` back to the URL via `pushState`, so a chosen config is shareable / reloadable.

The localStorage save state (best-lap times) is keyed by `(track, bike)` and persists across reloads independent of the URL params.
