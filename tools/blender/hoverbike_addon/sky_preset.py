"""Per-track sky / atmosphere authoring.

The runtime ships a tunable sky system (see
``src/engine/render/sky.ts``) — vertical palette ramp, sun disc with
halo, FBM cloud layer, optional starfield, plus a final color-grade
pass (tint × saturation × contrast). The whole atmosphere reads from
a small ``SkyConfig`` block in the track JSON:

  - ``tint`` (hex) — neutral white by default; biases everything
    warm/cool without touching the palette ramps.
  - ``cloudiness`` (0..1) — clear sky to solid overcast.
  - ``sunIntensity`` (≥0) — multiplier on the directional sun-light
    and sun-disc brightness.
  - ``fogNear`` / ``fogFar`` (m) — exponential fog distances. The
    horizon ring sits ~75 % through this range.
  - ``timeOfDay`` (s) — position along the sky system's 360 s day-
    night cycle, frozen for the race. 0 ≈ mid-morning, 180 ≈ pre-
    dusk, 270 ≈ deep night.
  - ``colorGrade`` (preset name) — bundled LUT preset
    (``miami_pastel``, ``tokyo_neon``, etc.).
  - ``bloom`` (0..2) — intensity multiplier on the renderer's bloom
    post-pass (see ``src/engine/render/post-pipeline.ts``). Typical
    ranges: 0.2–0.4 daytime, 0.4–0.7 sunset / overcast, 0.7–1.0
    neon / night. Above ~1.2 the bright sky starts saturating the
    framebuffer, so test the worst-case sun angle before pinning.
  - ``seaStateBeaufort`` (0..12) — drives a global amplitude scalar
    on the wave field's base spectrum. Beaufort 4 ≈ 1.0× (current
    default look). The runtime computes the multiplier via
    ``beaufortToAmplitudeScale``.

This module owns the scene properties + a sub-panel; ``_legacy.py``
owns the derive/reload plumbing that round-trips the values through
``public/tracks/<id>.json``.

The same load_post handler in ``handlers.py`` that auto-syncs other
track-JSON scene props picks up sky on .blend open without any
sky-specific wiring here.
"""

from __future__ import annotations

import bpy
from bpy.props import EnumProperty, FloatProperty, IntProperty


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

# Mirror of SKY_COLOR_GRADES in src/game/tracks/types.ts. Adding /
# removing a preset here without the TS counterpart will fail
# round-trip validation at runtime — same drift discipline as
# hoverbike_kinds.py / asset-kinds.ts.
SKY_COLOR_GRADES: tuple[tuple[str, str, str], ...] = (
    ("neutral", "Neutral", "No grade — identity tint × saturation × contrast"),
    ("miami_pastel", "Miami Pastel", "Soft warm-pink lift, lower saturation; sunset haze (Sandbar)"),
    ("mexico_city_rosa", "Mexico City Rosa", "Rosa-mexicano lift, punchy saturation; Texcoco Rising lake"),
    ("tokyo_neon", "Tokyo Neon", "Cool magenta-cyan lean, punchy saturation; Shibuya night"),
    ("big_sur_golden", "Big Sur Golden", "Golden-hour warmth; California / The Maw mid-day"),
    ("venice_warm", "Venice Warm", "Adriatic warm-stone amber; Doge's Drift"),
    ("nyc_sunset", "NYC Sunset", "Strong warm tint, high contrast; Liberty finale"),
    ("cape_town_blue", "Cape Town Blue", "Atlantic cool blue, desaturated haze"),
    ("kilauea_volcanic", "Kilauea Volcanic", "Ash + lava red lift, high contrast"),
)


# Property names this module owns. Kept as a constant so unregister()
# can walk them all without having to know each FloatProperty's
# attribute name in two places.
_SCENE_PROP_NAMES: tuple[str, ...] = (
    "hoverbike_sky_tint",
    "hoverbike_sky_cloudiness",
    "hoverbike_sky_cloud_towering",
    "hoverbike_sky_sun_size",
    "hoverbike_sky_sun_intensity",
    "hoverbike_sky_fog_near",
    "hoverbike_sky_fog_far",
    "hoverbike_sky_time_of_day",
    "hoverbike_sky_color_grade",
    "hoverbike_sky_bloom",
    "hoverbike_sky_sea_state",
)


# ────────────────────────────────────────────────────────────────────
# Hex tint helpers
# ────────────────────────────────────────────────────────────────────


def _hex_to_rgb(s: str) -> tuple[float, float, float]:
    """Parse a ``#rrggbb`` (or ``rrggbb``) string into linear-ish 0..1
    floats. Tolerant of stray whitespace + missing leading hash; falls
    back to white on malformed input so the picker never throws."""
    if not isinstance(s, str):
        return (1.0, 1.0, 1.0)
    t = s.strip().lstrip("#")
    if len(t) != 6:
        return (1.0, 1.0, 1.0)
    try:
        r = int(t[0:2], 16) / 255.0
        g = int(t[2:4], 16) / 255.0
        b = int(t[4:6], 16) / 255.0
    except ValueError:
        return (1.0, 1.0, 1.0)
    return (r, g, b)


def _rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    """Inverse of `_hex_to_rgb`. Clamps + rounds, returns ``#rrggbb``."""
    def comp(v: float) -> int:
        return max(0, min(255, int(round(v * 255.0))))
    return "#{:02x}{:02x}{:02x}".format(comp(rgb[0]), comp(rgb[1]), comp(rgb[2]))


def get_sky_tint_hex() -> str:
    """Read the scene's tint colour back as the hex string the JSON
    schema expects. The picker stores a (r,g,b) tuple; the JSON
    expects ``#rrggbb``."""
    scn = bpy.context.scene
    rgb = getattr(scn, "hoverbike_sky_tint", (1.0, 1.0, 1.0))
    return _rgb_to_hex(tuple(rgb))


def set_sky_tint_from_hex(hex_str: str) -> None:
    """Set the scene's tint colour from a ``#rrggbb`` hex string. Used
    by the JSON → Blender reload path."""
    scn = bpy.context.scene
    if scn is None:
        return
    if not hasattr(scn, "hoverbike_sky_tint"):
        return
    scn.hoverbike_sky_tint = _hex_to_rgb(hex_str)


# ────────────────────────────────────────────────────────────────────
# Derive / reload
# ────────────────────────────────────────────────────────────────────


def derive_sky_block() -> dict:
    """Pull the scene's sky knobs into a JSON-shaped dict matching
    `SkyConfig` in `src/game/tracks/types.ts`. Every field is optional
    in the runtime, but we always emit the full set so the JSON ↔
    Blender round-trip is lossless (and authors don't lose values when
    a knob coincidentally matches the runtime default).
    """
    scn = bpy.context.scene
    if scn is None or not hasattr(scn, "hoverbike_sky_color_grade"):
        return {}
    block: dict = {
        "tint": get_sky_tint_hex(),
        "cloudiness": float(scn.hoverbike_sky_cloudiness),
        "cloudTowering": float(getattr(scn, "hoverbike_sky_cloud_towering", 0.35)),
        "sunSize": float(getattr(scn, "hoverbike_sky_sun_size", 1.0)),
        "sunIntensity": float(scn.hoverbike_sky_sun_intensity),
        "fogNear": float(scn.hoverbike_sky_fog_near),
        "fogFar": float(scn.hoverbike_sky_fog_far),
        "timeOfDay": float(scn.hoverbike_sky_time_of_day),
        "colorGrade": str(scn.hoverbike_sky_color_grade),
        "bloom": float(scn.hoverbike_sky_bloom),
        "seaStateBeaufort": int(scn.hoverbike_sky_sea_state),
    }
    return block


def reload_sky_from_json(data: dict) -> bool:
    """JSON → Blender. Pull the `sky` block (if any) into the scene's
    sky props. Silently no-ops on missing / malformed entries so a
    partial JSON doesn't blow up the load_post handler.

    Returns True when at least one field was applied — the caller
    surfaces this in the reload summary."""
    sky = data.get("sky") if isinstance(data, dict) else None
    if not isinstance(sky, dict):
        return False
    scn = bpy.context.scene
    if scn is None:
        return False

    applied = False
    tint = sky.get("tint")
    if isinstance(tint, str) and hasattr(scn, "hoverbike_sky_tint"):
        set_sky_tint_from_hex(tint)
        applied = True
    for key, prop in (
        ("cloudiness", "hoverbike_sky_cloudiness"),
        ("cloudTowering", "hoverbike_sky_cloud_towering"),
        ("sunSize", "hoverbike_sky_sun_size"),
        ("sunIntensity", "hoverbike_sky_sun_intensity"),
        ("fogNear", "hoverbike_sky_fog_near"),
        ("fogFar", "hoverbike_sky_fog_far"),
        ("timeOfDay", "hoverbike_sky_time_of_day"),
        ("bloom", "hoverbike_sky_bloom"),
    ):
        v = sky.get(key)
        if isinstance(v, (int, float)) and hasattr(scn, prop):
            setattr(scn, prop, float(v))
            applied = True
    grade = sky.get("colorGrade")
    if isinstance(grade, str) and hasattr(scn, "hoverbike_sky_color_grade"):
        names = {g[0] for g in SKY_COLOR_GRADES}
        if grade in names:
            scn.hoverbike_sky_color_grade = grade
            applied = True
    beaufort = sky.get("seaStateBeaufort")
    if isinstance(beaufort, (int, float)) and hasattr(scn, "hoverbike_sky_sea_state"):
        scn.hoverbike_sky_sea_state = max(0, min(12, int(beaufort)))
        applied = True
    return applied


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


def register() -> None:
    bpy.types.Scene.hoverbike_sky_tint = bpy.props.FloatVectorProperty(
        name="Tint",
        description=(
            "Hex tint multiplied onto the sky palette. White = no tint. "
            "Use to bias warm (sunset) / cool (overcast) without rewriting "
            "the palette ramps."
        ),
        subtype="COLOR",
        size=3,
        min=0.0,
        max=1.0,
        default=(1.0, 1.0, 1.0),
        precision=3,
    )
    bpy.types.Scene.hoverbike_sky_cloudiness = FloatProperty(
        name="Cloudiness",
        description="0 = clear sky, 1 = solid overcast.",
        default=0.45,
        min=0.0,
        max=1.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_sky_cloud_towering = FloatProperty(
        name="Cloud towering",
        description=(
            "0..1 — domain-warped, self-shadowed billowing cumulus. 0 falls "
            "back to the flat legacy cloud band; higher = bigger, rounder, "
            "taller-reading masses with a cool base / warm top. Mirrors "
            "sky.cloudTowering in sky.ts. Default 0.35."
        ),
        default=0.35,
        min=0.0,
        max=1.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_sky_sun_size = FloatProperty(
        name="Sun size",
        description=(
            "Sun-disc size multiplier. 1.0 = tight ~1° disc; larger widens "
            "the disc and adds a warm corona (use a big value on sunset / "
            "finale tracks for a giant low sun). Mirrors sky.sunSize in sky.ts."
        ),
        default=1.0,
        min=0.2,
        max=8.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_sky_sun_intensity = FloatProperty(
        name="Sun intensity",
        description=(
            "Multiplier on the directional sun light + sun-disc brightness. "
            "Default 1.0; 0 = no sun (night), 2 = punchy mid-day."
        ),
        default=1.0,
        min=0.0,
        max=4.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_sky_fog_near = FloatProperty(
        name="Fog near (m)",
        description=(
            "Distance at which exponential fog begins. Default 500; the "
            "horizon ring sits ~75 % through fog range."
        ),
        default=500.0,
        min=10.0,
        max=10000.0,
        precision=0,
    )
    bpy.types.Scene.hoverbike_sky_fog_far = FloatProperty(
        name="Fog far (m)",
        description="Distance at which fog reaches full opacity. Default 2200.",
        default=2200.0,
        min=20.0,
        max=20000.0,
        precision=0,
    )
    bpy.types.Scene.hoverbike_sky_time_of_day = FloatProperty(
        name="Time of day (s)",
        description=(
            "Position along the sky's 360 s day-night cycle, frozen for "
            "the race. 0 ≈ mid-morning, 90 ≈ noon, 180 ≈ pre-dusk, "
            "270 ≈ night."
        ),
        default=0.0,
        min=0.0,
        max=360.0,
        precision=1,
    )
    bpy.types.Scene.hoverbike_sky_color_grade = EnumProperty(
        name="Color grade",
        description=(
            "Bundled LUT preset. Drives a per-preset (tint × saturation × "
            "contrast) tweak on the dome shader — no actual LUT image is "
            "sampled. 'neutral' is a no-op."
        ),
        items=SKY_COLOR_GRADES,
        default="neutral",
    )
    bpy.types.Scene.hoverbike_sky_bloom = FloatProperty(
        name="Bloom",
        description=(
            "Intensity multiplier on the renderer's bloom post-pass. "
            "Typical ranges: 0.2–0.4 daytime, 0.4–0.7 sunset/overcast, "
            "0.7–1.0 neon/night. Above ~1.2 bright skies start saturating "
            "the framebuffer; test the worst-case sun angle first."
        ),
        default=0.0,
        min=0.0,
        max=2.0,
        precision=2,
    )
    bpy.types.Scene.hoverbike_sky_sea_state = IntProperty(
        name="Sea state (Beaufort)",
        description=(
            "Beaufort wind scale 0..12. Drives a global amplitude scalar "
            "on the wave field's base spectrum at boot (Beaufort 4 ≈ 1.0×, "
            "0 ≈ glass-calm 0.15×, 12 ≈ hurricane 2.5×). Wave-zones layer "
            "on top, so a tsunami zone in a calm sea still surges. The "
            "scale is computed by beaufortToAmplitudeScale in sky.ts."
        ),
        default=4,
        min=0,
        max=12,
    )


def unregister() -> None:
    for prop in _SCENE_PROP_NAMES:
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
