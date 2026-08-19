"""Standalone headless track-hero render.

Runs the same rendering logic the addon's *Render Track Hero* operator
runs, but invokable from the command line for CI / batch builds. The
addon module ``kingtide_addon.thumbnail`` is the single source of
truth; this script just loads the package + delegates.

Usage (from the repo root):

    blender --background tracks-src/<id>.blend \\
        --python tools/blender/render_track_thumbnail.py

Or with ``BLENDER_EXE`` set:

    "$BLENDER_EXE" --background tracks-src/<id>.blend \\
        --python tools/blender/render_track_thumbnail.py

Output paths are derived from the .blend filename — running on
``tracks-src/seattle-sprint.blend`` writes
``public/assets/tracks/seattle-sprint-hero.jpg`` (1280×720, JPG q85)
and ``public/assets/tracks/seattle-sprint-thumb.jpg`` (320×180).

Exits non-zero if the .blend is unsaved, the track id isn't derivable,
the repo root can't be found, or the scene is missing a
``camera_hero``. CI scripts can rely on the exit code to gate the
loading-screen art on a successful render.

Pairs with the addon-side *Render Track Hero* operator (auto-fired on
track export) and the addon's Track thumbnail sub-panel. See
``docs/blender-pipeline-guide.md`` § Track hero render for the full
authoring loop.
"""

from __future__ import annotations

import os
import sys
import traceback


def _ensure_addon_importable() -> None:
    """The script is loaded by Blender's ``--python`` flag with the
    addon's parent dir already on sys.path when the addon is installed.
    For dev runs where the user hasn't installed the addon yet, fall
    back to inserting ``tools/blender/`` so the package import below
    works against the working tree.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)


def main() -> int:
    _ensure_addon_importable()

    # Importing the package triggers register() if the addon is set up
    # as an enabled Blender addon; for the bare-script path we don't
    # need the operators registered — we call the headless render_track_hero
    # helper directly, which is just a function.
    try:
        from kingtide_addon.thumbnail import find_camera_hero, render_track_hero
    except ImportError as e:
        print(f"[render_track_thumbnail] couldn't import kingtide_addon: {e}", file=sys.stderr)
        return 2

    import bpy

    blend = bpy.data.filepath
    if not blend:
        print(
            "[render_track_thumbnail] no .blend loaded — invoke with `blender --background <file>`",
            file=sys.stderr,
        )
        return 2

    if find_camera_hero() is None:
        print(
            "[render_track_thumbnail] no camera_hero in the scene — "
            "open the .blend in Blender and click *Add Camera Hero*",
            file=sys.stderr,
        )
        return 3

    try:
        hero, tile, ths, tts = render_track_hero(render_tile=True)
    except RuntimeError as e:
        print(f"[render_track_thumbnail] {e}", file=sys.stderr)
        return 4
    except Exception:  # noqa: BLE001 — render failures vary by build
        print("[render_track_thumbnail] render failed:", file=sys.stderr)
        traceback.print_exc()
        return 5

    print(f"[render_track_thumbnail] hero  → {hero} ({ths:.2f}s)")
    if tile:
        print(f"[render_track_thumbnail] tile  → {tile} ({tts:.2f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
