r"""Integration step of make-level-props — one .blend per AI prop.

Runs inside Blender headless. For each approved AI prop it conditions the
raw Hunyuan mesh into a pipeline-legal ``prop_<id>`` collection and saves it
to its **own** ``.blend`` in the Drive-synced content root —
``<content-root>/tracks-src/props/ai/<id>.blend`` (default content root
``C:\project-content\hoverbike``; see docs/asset-storage.md) — NOT the
shared ``props-library.blend`` and NOT the repo clone. Each file holds
exactly one asset-marked, ``hv_locked`` collection. The destination path is
chosen by make_level_props and arrives as the spec's ``output`` field.

This honours the raw-vs-compiled split: the **raw** ``.blend`` goes to the
content root (out of git), the **compiled** GLB stays in the repo.

Why per-file (the smallest-blast-radius model):

  * Regenerating one prop rewrites one small file; it can never corrupt
    the procedural ``props-library.blend`` or any sibling AI prop.
  * The folder *is* the library: the content root's ``tracks-src/`` is
    already a registered Blender asset library, and its **recursive** scan
    aggregates every ``tracks-src/props/ai/*.blend`` next to the procedural
    props under the shared ``King Tide/Track Props`` catalogue. No central
    file to open or merge.
  * ``hv_locked`` is stamped for consistency + intent (a standalone file is
    never re-seeded, so it is structurally safe already, but the marker
    documents "human-owned, AI output, do not regenerate" and protects the
    collection if it is ever linked into a re-seeded library).

The committed source of truth stays the conditioned GLB under
``public/assets/props/ai/<id>.glb`` (Git LFS) + the prompt in the manifest
— the ``.blend`` is a Drive-only authoring convenience (off git).

Headless scatter note: ``scatter_lib.drop_scatter_zone`` links a collection
by name from a single library path. To scatter an AI prop, point a scatter
zone at its per-file ``.blend`` (a small future enhancement to scatter_lib);
interactive placement via the Asset Browser works today with no change.

Invoked by tools/make_level_props.py as::

    blender --background --python tools/blender/integrate_ai_props.py \
        -- --spec <run>/_integrate_spec.json

Spec entry fields: input, prop_id, family, target_tris, target_height,
collider, tint, smooth, catalog, output (the per-prop .blend path).
"""

from __future__ import annotations

import json
import os
import sys

import bpy

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.blender.blender_assets_catalog import merge_catalog_file  # noqa: E402
from tools.blender.condition_ai_mesh import _import_any, condition_object  # noqa: E402
from tools.blender.seed_merge import LOCK, write_seedbak  # noqa: E402
from tools.blender.seed_props_library import CATALOG_UUIDS  # noqa: E402

CATALOG_ROOT = "King Tide/Track Props"


def _spec_path() -> str:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--spec" not in argv:
        raise SystemExit("[integrate] missing --spec <path>")
    return argv[argv.index("--spec") + 1]


def _mark_asset(coll: bpy.types.Collection, catalog: str) -> None:
    coll.asset_mark()
    uuid = CATALOG_UUIDS.get(f"{CATALOG_ROOT}/{catalog}")
    if coll.asset_data is not None:
        if uuid:
            coll.asset_data.catalog_id = uuid
        coll.asset_data.tags.new("ai-gen")


def _integrate_one(entry: dict) -> str:
    prop_id = entry["prop_id"]
    out = entry["output"]                       # tracks-src/props/ai/<id>.blend

    # Pristine single-collection file — full per-prop isolation.
    bpy.ops.wm.read_homefile(use_empty=True)

    obj = _import_any(entry["input"])
    root = condition_object(
        obj,
        prop_id=prop_id,
        family=entry.get("family", "prop"),
        target_tris=int(entry.get("target_tris", 2000)),
        target_height=entry.get("target_height"),
        source_up=entry.get("source_up", "Z"),
        collider=entry.get("collider", "box"),
        tint=entry.get("tint"),
        smooth=bool(entry.get("smooth", False)),
    )
    coll = bpy.data.collections.get(f"prop_{prop_id}")
    coll[LOCK] = 1                              # human-owned; never auto-regenerate
    root["ai_generated"] = True
    _mark_asset(coll, entry.get("catalog", "Rocks"))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_seedbak(out)                         # one-deep safety net before overwrite
    bpy.ops.wm.save_as_mainfile(filepath=out)
    return out


def main() -> None:
    with open(_spec_path(), "r", encoding="utf-8") as f:
        spec = json.load(f)
    if not spec:
        print("[integrate] empty spec — nothing to do")
        return

    # The per-prop blends land under <content-root>/tracks-src/props/ai/ (the
    # Drive-synced raw-source tree, out of git). Merge the King Tide/Track
    # Props catalogue rows into THAT tree's blender_assets.cats.txt — the one
    # the Asset Browser scans alongside the user's other blends — so each
    # per-file blend's catalog_id resolves. Idempotent; preserves existing
    # (procedural / landmark) rows. Derived from the output path so it always
    # tracks wherever make_level_props pointed the blends.
    cats_path = os.path.normpath(os.path.join(
        os.path.dirname(spec[0]["output"]), "..", "..", "blender_assets.cats.txt"))
    merge_catalog_file(cats_path, CATALOG_UUIDS)
    print(f"[integrate] catalogue merged → {cats_path}")

    written = []
    for entry in spec:
        path = _integrate_one(entry)
        written.append(path)
        print(f"[integrate] ✓ {entry['prop_id']} (hv_locked) → {path}")

    print(f"[integrate] wrote {len(written)} per-prop .blend file(s) to the "
          f"content root (raw sources, out of git):")
    for p in written:
        print(f"    {p}")


if __name__ == "__main__":
    main()
