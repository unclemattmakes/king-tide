"""Runtime terrain-shader scene properties + lap-count scalar.

These mirror constants in ``src/engine/render/terrain-shader.ts``;
``kingtide.export_track`` writes them into
``public/tracks/<id>.json`` so the runtime can rebuild the material
with the author's chosen values without touching the .ts. The
``kingtide.reload_track_json`` operator does the reverse — JSON
values flow back into these scene props when the file opens.

This module only owns the property *definitions*; the read/write
plumbing lives in `_legacy.derive_track_json` /
`_legacy.reload_track_from_json` (and will move with the rest of the
export-JSON layer in a follow-up).
"""

from __future__ import annotations

import bpy
from bpy.props import FloatProperty, IntProperty


_SCENE_PROP_NAMES: tuple[str, ...] = (
    # Core ramp + altitude band knobs.
    "hoverbike_shader_slope_start",
    "hoverbike_shader_slope_end",
    "hoverbike_shader_variation",
    "hoverbike_shader_wet_band",
    "hoverbike_shader_alt_min",
    "hoverbike_shader_alt_max",
    "hoverbike_shader_path_tint_r",
    "hoverbike_shader_path_tint_g",
    "hoverbike_shader_path_tint_b",
    # State-of-the-art coloration pass.
    "hoverbike_shader_warp_strength",
    "hoverbike_shader_macro_scale",
    "hoverbike_shader_micro_scale",
    "hoverbike_shader_alt_jitter",
    "hoverbike_shader_scree_band",
    "hoverbike_shader_saturation",
    "hoverbike_shader_triplanar",
    "hoverbike_shader_waterline",
    # Per-track lap count — round-trips through track JSON.
    "hoverbike_laps_to_finish",
)


def register() -> None:
    bpy.types.Scene.hoverbike_shader_slope_start = FloatProperty(
        name="Slope start (cos θ)",
        description="Cosine of the slope angle below which terrain reads as the flat (sand/grass) ramp. 0.85 ≈ 30°.",
        default=0.85, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_shader_slope_end = FloatProperty(
        name="Slope end (cos θ)",
        description="Cosine of the slope angle above which terrain reads as full cliff/rock. 0.55 ≈ 55°.",
        default=0.55, min=0.0, max=1.0, precision=3,
    )
    bpy.types.Scene.hoverbike_shader_variation = FloatProperty(
        name="Variation strength",
        description="±brightness perturbation from the per-vertex value-noise. 0 = flat ramps, 0.3 = soft, 0.6 = strong.",
        default=0.30, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_wet_band = FloatProperty(
        name="Wet band (m)",
        description="Half-height of the |y|-mask that darkens the terrain colour around the waterline.",
        default=2.0, min=0.0, max=20.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_alt_min = FloatProperty(
        name="Altitude band min (m)",
        description="World-Y mapped to ramp position 0 (deepest abyssal blue / dark rock).",
        default=-50.0, min=-500.0, max=0.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_alt_max = FloatProperty(
        name="Altitude band max (m)",
        description="World-Y mapped to ramp position 1 (volcanic top / brightest alpine).",
        default=120.0, min=0.0, max=500.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_r = FloatProperty(
        name="Path tint R", default=0.30, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_g = FloatProperty(
        name="Path tint G", default=0.24, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_path_tint_b = FloatProperty(
        name="Path tint B", default=0.18, min=0.0, max=2.0, precision=2,
    )

    # Per-track lap count.
    bpy.types.Scene.hoverbike_laps_to_finish = IntProperty(
        name="Laps to finish",
        description="Number of laps required to finish the race. Round-trips through public/tracks/<id>.json.",
        default=3, min=1, max=99,
    )

    # Extra terrain-shader knobs (state-of-the-art coloration pass).
    # See terrain-shader.ts for the matching uniforms.
    bpy.types.Scene.hoverbike_shader_warp_strength = FloatProperty(
        name="Domain warp",
        description="Strength of the low-freq noise that warps the colour-noise UVs. 0 = stock, 0.5 = subtle, 1.5 = strong organic veining.",
        default=0.5, min=0.0, max=4.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_macro_scale = FloatProperty(
        name="Macro scale",
        description="World-space scale (m) of the macro biome variation. 50 m ≈ smooth rolling tints; 200 m ≈ continent-scale bands.",
        default=120.0, min=10.0, max=1000.0, precision=1,
    )
    bpy.types.Scene.hoverbike_shader_micro_scale = FloatProperty(
        name="Micro scale",
        description="World-space scale (m) of the micro detail variation. 4 m ≈ pebbly, 16 m ≈ shrubs.",
        default=8.0, min=0.5, max=40.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_alt_jitter = FloatProperty(
        name="Alt jitter (m)",
        description="Vertical jitter added to the altitude band per fragment so contour lines aren't perfectly level. 0 = banded, 6 = naturally feathered.",
        default=4.0, min=0.0, max=30.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_scree_band = FloatProperty(
        name="Scree band",
        description="Width of the scree (intermediate slope) band between flat and cliff ramps. 0 = hard cut to cliff, 0.4 = wide gravel scree transition.",
        default=0.25, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_saturation = FloatProperty(
        name="Saturation",
        description="Output saturation multiplier. 1 = neutral, 1.2 = punchier biome reads, 0.7 = washed-out / stylised.",
        default=1.05, min=0.0, max=2.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_triplanar = FloatProperty(
        name="Triplanar",
        description="Blend factor between top-down (XZ-only) sampling and triplanar XYZ sampling for cliffs. 0 = stock, 1 = fully triplanar (no stretching on vertical faces).",
        default=0.6, min=0.0, max=1.0, precision=2,
    )
    bpy.types.Scene.hoverbike_shader_waterline = FloatProperty(
        name="Waterline trio",
        description="Strength of the built/broken/blooming waterline bands (algae fringe below + barnacle/verdigris crust at + salt-bleach above the sea line) painted onto terrain that crosses the waterline. 0 = off (byte-identical legacy), 1 = full. Mirrors terrainShader.waterline in terrain-shader.ts.",
        default=0.0, min=0.0, max=1.0, precision=2,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        if hasattr(bpy.types.Scene, prop):
            try:
                delattr(bpy.types.Scene, prop)
            except Exception:  # noqa: BLE001
                pass
