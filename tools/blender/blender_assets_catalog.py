"""Shared helper for ``tracks-src/blender_assets.cats.txt``.

Blender expects exactly one ``blender_assets.cats.txt`` per asset library
folder. ``tracks-src/`` is one library, but it's populated by multiple
seed scripts (``seed_props_library.py``, ``seed_landmarks_library.py``,
and any future siblings). Each seed owns its own UUID→catalog-path
mapping. If every seed *overwrites* the file with only its own rows,
running one wipes the others' catalogue entries — that's the regression
authors hit when re-seeding props after landmarks (or vice-versa).

This module exposes one function — :func:`merge_catalog_file` — that
each seed calls with its own UUID dict. The function:

1. Reads any existing ``<uuid>:<path>:<simple_name>`` rows from the file.
2. Adds/overwrites only the UUIDs in the seed's dict.
3. Writes the union back, sorted by UUID for stability.

Idempotent — re-running a seed produces a byte-stable output (mod
unrelated row additions from sibling seeds).
"""

from __future__ import annotations

import os
from typing import Mapping


_HEADER_LINES = (
    "# This is an Asset Catalog Definition file for Blender.",
    "#",
    "# Empty lines and lines starting with `#` are ignored.",
    "# The first non-ignored line should be the version indicator.",
    "# Other lines are of the format \"UUID:catalog/path/for/assets:simple catalog name\"",
    "",
    "VERSION 1",
    "",
)


def merge_catalog_file(path: str, uuid_to_catalog_path: Mapping[str, str]) -> None:
    """Merge ``uuid_to_catalog_path`` into the catalogue file at ``path``.

    Preserves any rows whose UUID isn't in the caller's dict (other
    seeds' entries) and overwrites any whose UUID *is* in the dict
    (so a path rename or simple-name change picks up). Header and row
    ordering are stable so the file diffs cleanly in source control.

    Args:
        path: Absolute path to ``blender_assets.cats.txt``.
        uuid_to_catalog_path: Mapping from canonical Blender catalog
            UUID strings to forward-slash catalog paths
            (``"Hoverbike/Track Props/Palms"`` style). The simple name
            is derived as the path with ``/`` replaced by ``-``, which
            matches Blender's expectation.
    """
    existing_rows: dict[str, str] = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("VERSION"):
                    continue
                parts = line.split(":", 2)
                if len(parts) == 3:
                    existing_rows[parts[0]] = line

    for catalog_path, uid in uuid_to_catalog_path.items():
        simple = catalog_path.replace("/", "-")
        existing_rows[uid] = f"{uid}:{catalog_path}:{simple}"

    rows = sorted(existing_rows.values())
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(list(_HEADER_LINES) + rows) + "\n")
