"""Headless bike GLB builder. ``bikes-src/<id>.blend`` → GLB.

Run:
    HOVERBIKE_SPEC=specs/bikes/racer.json \\
    HOVERBIKE_OUTPUT=public/assets/bikes/racer.glb \\
      blender --background --python tools/blender/build_bike.py

Mirrors the track pipeline: every bike has a standalone ``.blend`` at
``bikes-src/<id>.blend`` that authors edit directly (no shared kit).
The builder opens that ``.blend``, optionally overlays spec-driven
material colours + extras, validates the structure, and exports the
GLB.

Spec is loaded for two purposes:

1. **Resolving the source ``.blend``** — ``spec.id`` picks
   ``bikes-src/<id>.blend``.
2. **Optional overrides.** ``spec.appearance.*`` recolours any
   ``mat_bike_<id>_*`` materials present in the ``.blend`` (so colour
   tuning stays JSON-fast without reopening Blender). ``spec.physics``
   + ``displayName`` are written into ``bike_root`` extras so the
   runtime manifest + viewer HUD can read them. Both blocks are
   optional — drop them from the spec to use whatever's authored in
   the ``.blend``.

### Authoring frame

Authoring is in Blender axes (X=right, +Z up). The yup glTF exporter
maps Blender (X, Y, Z) → three (X, Z, -Y), so:

  Blender +X (width)  → three +X (right)
  Blender +Z (height) → three +Y (up)
  Blender -Y          → three +Z (forward, where the bike's nose ends up)
  Blender +Y          → three -Z (back)

Place the bike's NOSE at Blender -Y so the exported nose ends up at
three +Z forward — matches docs/status.md's "+Z is forward" convention.
"""

from __future__ import annotations

import os
import sys

# When Blender runs this script via --python, the parent dir isn't on
# sys.path. Put the repo root there so shared helpers import cleanly
# under their package paths.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bpy  # noqa: E402

from tools.blender import sockets as sockets_mod  # noqa: E402
from tools.blender.common import (  # noqa: E402
    REPO_ROOT,
    apply_extras,
    export_glb,
    output_path,
    read_spec,
    validate_required_kinds,
)


def hex_to_rgba(s: str) -> tuple[float, float, float, float]:
    """``#rrggbb`` → linear-space RGBA (sRGB→linear via 2.2 gamma)."""
    s = s.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)


def open_source_blend(spec: dict) -> str:
    """Resolve and open ``bikes-src/<id>.blend``. Errors if missing."""
    bike_id = spec["id"]
    blend_path = os.path.join(REPO_ROOT, "bikes-src", f"{bike_id}.blend")
    if not os.path.exists(blend_path):
        raise SystemExit(
            f"[build-bike] source .blend not found: {blend_path}\n"
            f"  Author one in Blender (see docs/blender-pipeline-guide.md), "
            f"or run the bootstrap seeder if your repo predates the per-variant "
            f"flow."
        )
    print(f"[build-bike] opening {blend_path}")
    bpy.ops.wm.open_mainfile(filepath=blend_path)
    return blend_path


def apply_spec_overrides(spec: dict) -> None:
    """Overlay JSON-driven tuning on top of what's authored in the
    ``.blend``: bike_root extras (so the runtime sees the spec's
    physics + display name) and ``mat_bike_<id>_*`` material colours
    (so palette tweaks don't need a Blender round-trip).

    Both blocks are optional: a fully-authored ``.blend`` with no
    overrides ships unchanged. The match-by-name approach for
    materials means the .blend's other materials (lights, helpers)
    are untouched.
    """
    bike_id = spec["id"]

    # ── bike_root extras ────────────────────────────────────────────────────
    bike_root = bpy.data.objects.get("bike_root")
    if bike_root is None:
        # Validation will catch this and abort with a helpful error;
        # don't crash here on the override step.
        return

    display_name = spec.get("displayName")
    if display_name is not None:
        bike_root["display_name"] = str(display_name)
    bike_root["bike_id"] = bike_id

    phys_ = spec.get("physics") or {}
    if "massKg" in phys_:
        bike_root["mass_kg"] = float(phys_["massKg"])
    if "topSpeedMps" in phys_:
        bike_root["top_speed_mps"] = float(phys_["topSpeedMps"])
    if "hoverHeight" in phys_:
        bike_root["hover_height"] = float(phys_["hoverHeight"])

    # ── material colours ────────────────────────────────────────────────────
    appear = spec.get("appearance") or {}
    overrides: dict[str, dict] = {}
    if "metalColor" in appear:
        # The chassis + fork share the metal palette (different
        # roughness/metallic per the seeder; we only retint base
        # colour here so author tweaks to roughness ride through).
        overrides[f"mat_bike_{bike_id}_chassis"] = {"color": appear["metalColor"]}
        overrides[f"mat_bike_{bike_id}_fork"] = {"color": appear["metalColor"]}
    if "liveryColor" in appear:
        overrides[f"mat_bike_{bike_id}_livery"] = {"color": appear["liveryColor"]}
        # Fin uses livery colour both as base AND emissive — keep both
        # in sync when the spec retints.
        overrides[f"mat_bike_{bike_id}_fin"] = {
            "color": appear["liveryColor"],
            "emissive": appear["liveryColor"],
        }
    if "glowColor" in appear:
        overrides[f"mat_bike_{bike_id}_glow"] = {
            "color": appear["glowColor"],
            "emissive": appear["glowColor"],
        }
        if "glowIntensity" in appear:
            overrides[f"mat_bike_{bike_id}_glow"]["emissive_intensity"] = float(
                appear["glowIntensity"]
            )

    for mat_name, ovr in overrides.items():
        mat = bpy.data.materials.get(mat_name)
        if mat is None or not mat.use_nodes:
            continue
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        if "color" in ovr:
            bsdf.inputs["Base Color"].default_value = hex_to_rgba(ovr["color"])
        if "emissive" in ovr:
            for em_input in ("Emission", "Emission Color"):
                if em_input in bsdf.inputs:
                    bsdf.inputs[em_input].default_value = hex_to_rgba(ovr["emissive"])
        if "emissive_intensity" in ovr and "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = float(
                ovr["emissive_intensity"]
            )


REQUIRED_SLOTS = ["seat", "nose_cam", "fx_thruster_l", "fx_thruster_r", "fx_exhaust"]


def validators_factory(spec: dict):
    """Run after overrides so the .blend's authored kinds + the spec's
    bike_id agree. Two cheap checks beyond the standard kind census:
    bike_root's ``bike_id`` matches ``spec.id``, and every required
    socket slot is present (the addon validates these too)."""

    def _validate() -> list[str]:
        errs: list[str] = []
        errs.extend(
            validate_required_kinds(
                {"bike": 1, "socket": (5, None), "collider": (1, None)}
            )
        )
        errs.extend(sockets_mod.validate_sockets(REQUIRED_SLOTS))

        bike_root = bpy.data.objects.get("bike_root")
        if bike_root is None:
            errs.append("missing object: bike_root")
        else:
            stored = bike_root.get("bike_id")
            if stored != spec["id"]:
                errs.append(
                    f"bike_root.extras.bike_id={stored!r} does not match "
                    f"spec.id={spec['id']!r} — re-run the seeder or fix the "
                    f"custom property"
                )
        return errs

    return _validate


def build() -> None:
    spec = read_spec()
    out = output_path()
    print(f"[build-bike] {spec['id']} -> {out}")

    open_source_blend(spec)
    apply_spec_overrides(spec)
    export_glb(out, validators=[validators_factory(spec)])


if __name__ == "__main__":
    try:
        build()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[build-bike] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
