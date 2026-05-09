"""Headless bike GLB builder. Spec → GLB.

Run:
    HOVERBIKE_SPEC=specs/bikes/racer.json \\
    HOVERBIKE_OUTPUT=public/assets/bikes/racer.glb \\
      blender --background --python tools/blender/build_bike.py

Reads the spec, appends kit parts from tools/blender/lib/bike_parts.blend,
assembles a `bike_root` empty with chassis + fairing + thrusters + fork,
applies spec-driven appearance to materials (renamed `mat_bike_<id>_*`),
wires up sockets (seat, nose_cam, fx_thruster_l/r, fx_exhaust), adds a
primitive collider derived from spec.geometry, validates the kind/socket
contract, exports.

### Authoring frame

Authoring is in Blender axes (X=right, +Z up). The yup glTF exporter
maps Blender (X, Y, Z) → three (X, Z, -Y), so:

  Blender +X (width)  → three +X (right)
  Blender +Z (height) → three +Y (up)
  Blender -Y          → three +Z (forward, where the bike's nose ends up)
  Blender +Y          → three -Z (back)

We place the bike's NOSE at Blender -Y so it lands at three +Z forward —
matching docs/status.md's "+Z is forward" convention and the procedural
`createBikeMesh()` mesh that this builder replaces.

### Extras axis swap

`extras` values are pass-through — the exporter writes the literal JSON.
Where extras carry axis-aligned data (`half_extents`, `seatOffset`),
the builder writes them already in three's axes ([right, up, forward])
so the runtime can use them without remapping.
"""

from __future__ import annotations

import os
import sys

# When Blender runs this script via --python, the parent dir isn't on
# sys.path. We import shared helpers as `tools.blender.<mod>` — put the
# repo root on sys.path so that resolves.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bpy  # noqa: E402

from tools.blender import colliders as colliders_mod  # noqa: E402
from tools.blender import sockets as sockets_mod  # noqa: E402
from tools.blender.common import (  # noqa: E402
    REPO_ROOT,
    apply_extras,
    export_glb,
    output_path,
    read_spec,
    reset_scene,
    validate_required_kinds,
)
from tools.blender.lib_loader import append_objects  # noqa: E402

KIT_BLEND = os.path.join(REPO_ROOT, "tools", "blender", "lib", "bike_parts.blend")


def hex_to_rgba(s: str) -> tuple[float, float, float, float]:
    """#rrggbb → linear RGBA. Blender's principled BSDF expects linear
    space; sRGB→linear approximated via 2.2 power."""
    s = s.lstrip("#")
    r = int(s[0:2], 16) / 255.0
    g = int(s[2:4], 16) / 255.0
    b = int(s[4:6], 16) / 255.0
    return (r ** 2.2, g ** 2.2, b ** 2.2, 1.0)


def make_material(
    name: str,
    color_hex: str,
    *,
    emissive_hex: str | None = None,
    emissive_intensity: float = 0.0,
    metallic: float = 0.2,
    roughness: float = 0.5,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat
    bsdf.inputs["Base Color"].default_value = hex_to_rgba(color_hex)
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    if emissive_hex is not None:
        if "Emission" in bsdf.inputs:
            bsdf.inputs["Emission"].default_value = hex_to_rgba(emissive_hex)
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = hex_to_rgba(emissive_hex)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emissive_intensity
    return mat


def select_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_transforms(obj: bpy.types.Object) -> None:
    select_only(obj)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)


def build() -> None:
    spec = read_spec()
    bike_id = spec["id"]
    geom = spec["geometry"]
    phys_ = spec["physics"]
    appear = spec["appearance"]
    rider = spec["rider"]

    out = output_path()
    print(f"[build-bike] {bike_id} -> {out}")

    reset_scene()

    width = float(geom["chassisWidth"])
    length = float(geom["chassisLength"])
    height = float(geom["chassisHeight"])

    chassis_mat = make_material(
        f"mat_bike_{bike_id}_chassis", appear["metalColor"], metallic=0.6, roughness=0.4,
    )
    fairing_mat = make_material(
        f"mat_bike_{bike_id}_livery", appear["liveryColor"], metallic=0.3, roughness=0.45,
    )
    thruster_mat = make_material(
        f"mat_bike_{bike_id}_glow",
        appear["glowColor"],
        emissive_hex=appear["glowColor"],
        emissive_intensity=appear["glowIntensity"],
        metallic=0.1,
        roughness=0.3,
    )
    fork_mat = make_material(
        f"mat_bike_{bike_id}_fork", appear["metalColor"], metallic=0.7, roughness=0.35,
    )

    # bike_root: canonical entry node. Runtime reads kind="bike" off it
    # and resolves socket children by name.
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    bike_root = bpy.context.active_object
    bike_root.name = "bike_root"
    apply_extras(
        bike_root,
        kind="bike",
        bike_id=bike_id,
        mass_kg=float(phys_["massKg"]),
        top_speed_mps=float(phys_["topSpeedMps"]),
        hover_height=float(phys_["hoverHeight"]),
    )

    # Chassis: scale unit cube to (W, L, H) and lift so its base sits at Z=0.
    [chassis] = append_objects(KIT_BLEND, ["chassis_base"])
    chassis.name = "bike_body"
    chassis.scale = (width, length, height)
    chassis.location = (0.0, 0.0, height * 0.5)
    apply_transforms(chassis)
    chassis.parent = bike_root
    chassis.data.materials.clear()
    chassis.data.materials.append(chassis_mat)

    # Fairing on top of the chassis, scaled to chassis footprint.
    fairing_name = f"fairing_{geom['fairingStyle']}"
    [fairing] = append_objects(KIT_BLEND, [fairing_name])
    fairing.name = "bike_fairing"
    fairing.scale = (width, length, 1.0)
    fairing.location = (0.0, 0.0, height + 0.15)
    apply_transforms(fairing)
    fairing.parent = bike_root
    fairing.data.materials.clear()
    fairing.data.materials.append(fairing_mat)

    # Fork at the front of the chassis (Blender -Y = bike nose).
    fork_name = f"fork_{geom['fork']}"
    [fork] = append_objects(KIT_BLEND, [fork_name])
    fork.name = "bike_fork"
    nose_y = -length * 0.5 + 0.1
    fork.location = (0.0, nose_y, height * 0.4)
    apply_transforms(fork)
    fork.parent = bike_root
    fork.data.materials.clear()
    fork.data.materials.append(fork_mat)

    # Thrusters: duplicate kit unit per spec.thrusterCount, spread on X
    # by spec.thrusterSpacing. They sit at the tail (Blender +Y) at half
    # chassis height.
    thruster_count = int(geom["thrusterCount"])
    spacing = float(geom["thrusterSpacing"])
    tail_y = length * 0.5 - 0.15
    thruster_z = height * 0.35
    for i in range(thruster_count):
        # Symmetric layout: x = spacing * (i - (N-1)/2) — N=1 → 0; N=2 →
        # ±s/2; N=4 → ±s/2, ±3s/2.
        offset = spacing * (i - (thruster_count - 1) / 2.0)
        [t] = append_objects(KIT_BLEND, ["thruster_unit"])
        t.name = f"bike_thruster_{i}"
        t.location = (offset, tail_y, thruster_z)
        apply_transforms(t)
        t.parent = bike_root
        t.data.materials.clear()
        t.data.materials.append(thruster_mat)

    # Front-facing fin marker — restores the visual nose cue the
    # procedural bike-mesh.ts had (yellow cone pointing +Z).
    fin_mat = make_material(
        f"mat_bike_{bike_id}_fin", appear["liveryColor"],
        emissive_hex=appear["liveryColor"], emissive_intensity=0.5,
        metallic=0.2, roughness=0.4,
    )
    [fin] = append_objects(KIT_BLEND, ["fin_marker"])
    fin.name = "bike_fin"
    fin.location = (0.0, -length * 0.5 + 0.05, height + 0.35)
    apply_transforms(fin)
    fin.parent = bike_root
    fin.data.materials.clear()
    fin.data.materials.append(fin_mat)

    # Rear tail-light marker — mirrors the procedural red tail.
    tail_mat = make_material(
        f"mat_bike_{bike_id}_tail", "#ff3333",
        emissive_hex="#ff3333", emissive_intensity=1.0,
        metallic=0.0, roughness=0.4,
    )
    [tail] = append_objects(KIT_BLEND, ["tail_marker"])
    tail.name = "bike_tail"
    tail.location = (0.0, length * 0.5 - 0.05, height + 0.05)
    apply_transforms(tail)
    tail.parent = bike_root
    tail.data.materials.clear()
    tail.data.materials.append(tail_mat)

    # Sockets — placed in Blender authoring frame; the GLTFLoader
    # converts them to three's axes correctly via standard yup export.
    #
    # spec.rider.seatOffset is in **three.js** axes ([right, up, forward])
    # because that's how it's consumed by the runtime. We swap it back
    # to Blender axes (X, Y, Z) = (right, -forward, up).
    seat_offset = rider["seatOffset"]
    seat_xyz_blender = (seat_offset[0], -seat_offset[2], seat_offset[1])
    sockets_mod.add_socket(
        "socket_seat", bike_root, slot="seat", location=seat_xyz_blender
    )
    # Nose camera anchor: just past the bike's nose, slightly above chassis top.
    sockets_mod.add_socket(
        "socket_nose_cam",
        bike_root,
        slot="nose_cam",
        location=(0.0, -length * 0.5 - 0.2, height * 0.6),
    )
    # FX anchors at the outer thrusters' rear edge.
    fx_x = (
        max(0.15, spacing * (thruster_count - 1) / 2.0)
        if thruster_count > 1
        else 0.15
    )
    sockets_mod.add_socket(
        "socket_fx_thruster_l",
        bike_root,
        slot="fx_thruster_l",
        location=(-fx_x, tail_y + 0.25, thruster_z),
    )
    sockets_mod.add_socket(
        "socket_fx_thruster_r",
        bike_root,
        slot="fx_thruster_r",
        location=(fx_x, tail_y + 0.25, thruster_z),
    )
    sockets_mod.add_socket(
        "socket_fx_exhaust",
        bike_root,
        slot="fx_exhaust",
        location=(0.0, tail_y + 0.4, thruster_z * 0.5),
    )

    # Primitive box collider. Authoring transform stays in Blender axes;
    # the GLTFLoader converts at load time. But `extras.half_extents` is
    # opaque to the exporter, so we write it pre-converted to three's
    # axes (right, up, forward) = (W/2, H/2, L/2).
    bpy.ops.object.empty_add(type="CUBE", location=(0.0, 0.0, height * 0.5))
    collider = bpy.context.active_object
    collider.name = "collider_body"
    collider.scale = (width * 0.55, length * 0.5, height * 0.6)
    collider.parent = bike_root
    apply_extras(
        collider,
        kind="collider",
        shape="box",
        half_extents=[width * 0.55, height * 0.6, length * 0.5],
    )

    def validators() -> list[str]:
        errs: list[str] = []
        errs.extend(
            validate_required_kinds(
                {"bike": 1, "socket": (5, None), "collider": (1, None)}
            )
        )
        errs.extend(
            sockets_mod.validate_sockets(
                ["seat", "nose_cam", "fx_thruster_l", "fx_thruster_r", "fx_exhaust"],
            )
        )
        return errs

    export_glb(out, validators=[validators])


if __name__ == "__main__":
    try:
        build()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[build-bike] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
