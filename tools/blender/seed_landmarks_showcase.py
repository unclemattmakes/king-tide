"""Seed ``tracks-src/landmarks-showcase.blend`` — a reference scene that
drops one of every landmark archetype on a 100 m × 100 m grid so authors
can eyeball silhouette + scale at race-pace distance.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/seed_landmarks_showcase.py

Or via the pnpm wrapper:
    pnpm seed:landmarks-showcase

This is a *reference* file — it is NOT consumed by the runtime, and
it does NOT participate in the Asset Browser catalogue (the
authoritative archetypes live in ``landmarks-library.blend``). The
showcase exists purely so the next track-author can open one Blender
window and see every silhouette at once before deciding which
archetypes to drag into a new track.

Re-running the seed nuke-and-paves the showcase .blend.
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# Reuse the library builders directly — the seed scripts are pure
# Python with no Blender-state side effects at import time, so
# importing them inside another bpy session is safe.
from tools.blender import seed_landmarks_library as lib  # noqa: E402

OUTPUT_PATH = os.path.join(REPO_ROOT, "tracks-src", "landmarks-showcase.blend")

# 100 m × 100 m grid spacing.
GRID_SPACING = 100.0
GRID_COLS = 5


def _placement(index: int) -> tuple[float, float, float]:
    col = index % GRID_COLS
    row = index // GRID_COLS
    return (col * GRID_SPACING, row * GRID_SPACING, 0.0)


def main() -> None:
    print(f"[seed-landmarks-showcase] writing → {OUTPUT_PATH}")
    bpy.ops.wm.read_homefile(use_empty=True)

    # Build the library (materials + collections) into this scene; we
    # then move each landmark's mesh object onto the showcase grid.
    summary = lib.build_landmarks()

    # Walk every marked-asset collection. The lib's _make_collection
    # puts each landmark's mesh object at its LAYOUT position; we
    # override that with our grid layout for the showcase view.
    landmark_collections = sorted(
        [c for c in bpy.data.collections if c.asset_data is not None
         and c.name.startswith("landmark_")],
        key=lambda c: c.name,
    )

    for i, coll in enumerate(landmark_collections):
        pos = _placement(i)
        for obj in coll.objects:
            # mechanical_rig has 2 objects (base + parented arm); the
            # arm's transform is local to the base, so only re-position
            # objects with no parent.
            if obj.parent is None:
                obj.location = pos

    # The showcase isn't the asset library — clear asset marks so
    # opening this .blend doesn't double-register catalog entries.
    for c in landmark_collections:
        if c.asset_data is not None:
            c.asset_clear()

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_PATH)

    print(f"[seed-landmarks-showcase] done — {len(summary)} archetypes "
          f"on a {GRID_COLS}-wide grid")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[seed-landmarks-showcase] FAILED: {e}", file=sys.stderr)
        raise
