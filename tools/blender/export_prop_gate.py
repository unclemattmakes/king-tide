"""Export `prop_gate_mesh` from `tracks-src/props-library.blend` to
`public/assets/props/gate.glb` for runtime gate instancing.

Run:
    "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" \\
      --background --python tools/blender/export_prop_gate.py
    # or:
    pnpm gen:prop-gate

Why this exists
----------------

The track-side runtime in ``src/engine/render/track-mesh.ts`` used to
build gate visuals from primitive geometry (CylinderGeometry pillars
+ BoxGeometry crossbar). The author-side preview in Blender, by
contrast, instances ``prop_gate_mesh`` from the props library — so
what the author saw and what the player saw drifted apart over time.

This script bridges that gap: it lifts ``prop_gate_mesh`` out of the
library .blend and writes it to a standalone GLB that the runtime
loads once and clones per gate. Result: a single canonical gate
mesh, authored in Blender, instanced in-game.

The script is **read-only** against the library — no mutation of
``props-library.blend``. It opens the .blend in a background Blender
process, isolates the gate, exports, and exits.

Idempotent: re-running overwrites the GLB. CI should call this after
``seed:props-library`` (which builds the library) so the runtime
asset reflects the latest gate geometry.
"""

from __future__ import annotations

import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
LIBRARY_PATH = os.path.join(REPO_ROOT, "tracks-src", "props-library.blend")
OUTPUT_PATH = os.path.join(REPO_ROOT, "public", "assets", "props", "gate.glb")
PROP_GATE_MESH_NAME = "prop_gate_mesh"
PROP_GATE_OBJECT_PREFIX = "prop_gate"  # the in-library mesh-object name


def fail(msg: str) -> None:
    print(f"[export-prop-gate] FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    print(f"[export-prop-gate] {msg}")


def main() -> int:
    if not os.path.isfile(LIBRARY_PATH):
        fail(f"props library not found at {LIBRARY_PATH}")

    log(f"opening {LIBRARY_PATH}")
    # ``open_mainfile`` swaps the scene wholesale — fine in a background
    # Blender process that has no other state to lose.
    bpy.ops.wm.open_mainfile(filepath=LIBRARY_PATH)

    # Find the mesh-object that wears prop_gate_mesh. The seed builds
    # one object per prop inside a collection — for the gate the object
    # is named "prop_gate_mesh" (object), referencing the mesh of the
    # same name. We grab the mesh datablock directly so it doesn't
    # matter what the object is named in any one revision of the seed.
    gate_mesh = bpy.data.meshes.get(PROP_GATE_MESH_NAME)
    if gate_mesh is None:
        fail(
            f"mesh {PROP_GATE_MESH_NAME!r} not found in library. "
            f"Re-seed the props library (`pnpm seed:props-library` or "
            f"`blender --background --python tools/blender/seed_props_library.py`) "
            f"before exporting."
        )
    log(f"found {PROP_GATE_MESH_NAME}: {len(gate_mesh.vertices)} verts, "
        f"{len(gate_mesh.polygons)} polys")

    # Stage a clean export scene: link a freshly-built object using the
    # gate mesh into a throwaway scene so the GLB exporter sees ONLY
    # the gate, without picking up library siblings (palms, rocks, buoys)
    # or library Empty parents. Cheaper + more deterministic than
    # selecting-and-exporting from the live scene.
    export_scene = bpy.data.scenes.new("hoverbike_gate_export")
    bpy.context.window.scene = export_scene

    # Object name "gate_prop" is what the runtime can look up by name if
    # we ever need to disambiguate multiple props in one GLB. For now
    # the GLB ships a single mesh, so the name is mostly cosmetic.
    gate_obj = bpy.data.objects.new("gate_prop", gate_mesh)
    export_scene.collection.objects.link(gate_obj)
    # Make it the active + selected object so the exporter's
    # use_selection codepath sees it.
    bpy.context.view_layer.objects.active = gate_obj
    gate_obj.select_set(True)

    # Center the mesh at origin so the runtime can place its instances
    # straight at the checkpoint position without compensating for an
    # author-time offset. The library's prop_gate_mesh was already
    # built around the origin (per seed_props_library.build_gate_mesh)
    # but assert to be safe.
    gate_obj.location = (0.0, 0.0, 0.0)
    gate_obj.rotation_euler = (0.0, 0.0, 0.0)
    gate_obj.scale = (1.0, 1.0, 1.0)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    log(f"exporting → {OUTPUT_PATH}")

    bpy.ops.export_scene.gltf(
        filepath=OUTPUT_PATH,
        export_format="GLB",
        # +Z (Blender) → +Y (three.js) — same convention every other
        # Hoverbike GLB ships with.
        export_yup=True,
        export_apply=False,  # gate is plain mesh — no modifiers to bake
        use_selection=True,
        use_visible=True,
        use_renderable=False,
        use_active_collection=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_materials="EXPORT",
    )

    log(f"done — {os.path.getsize(OUTPUT_PATH):,} bytes")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[export-prop-gate] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
