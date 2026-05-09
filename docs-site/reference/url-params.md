# URL parameters

The game accepts query-string parameters at the root URL. They compose freely.

| Param | Values | Default | Effect |
|---|---|---|---|
| `track` | `lagoon` \| `cliffside` \| `calibration` \| `test-ring` \| any id under `public/tracks/` | `lagoon` | Picks the track. JSON-driven tracks are loaded from `public/tracks/<id>.json`. |
| `bike` | `cruiser` \| `racer` \| `stunt` \| any id under `public/assets/bikes/` | `racer` | Picks the player bike variant. |
| `edit` | `1` | off | Opens the in-app track editor instead of the racer. Defaults the track to `lagoon-edit` if `track` isn't set. See [Authoring tracks → Editor-driven](/modding/tracks#editor-driven-authoring). |

## Examples

| URL | What you get |
|---|---|
| `http://localhost:5191/` | Lagoon Loop, Racer bike — default config |
| `http://localhost:5191/?track=cliffside` | Cliffside, Racer bike |
| `http://localhost:5191/?bike=stunt` | Lagoon Loop, Stunt bike |
| `http://localhost:5191/?track=cliffside&bike=stunt` | "The most fun config" per the README |
| `http://localhost:5191/?edit=1` | Track editor over `lagoon-edit` |
| `http://localhost:5191/?track=mybeach&edit=1` | Editor over a specific (or new) JSON track |

## Persistence

URL params are read once at boot. Changing the URL while the game is running has no effect — reload to apply.

The Garage menu (HUD button, top-right) writes the chosen `bike` + `track` back to the URL via `pushState`, so a chosen config is shareable / reloadable.

The localStorage save state (best-lap times) is keyed by `(track, bike)` and persists across reloads independent of the URL params.
