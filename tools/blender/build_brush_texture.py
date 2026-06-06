"""Generate ``public/assets/textures/brush_strokes.png`` — the shared, seamless,
painterly brush-stroke HEIGHT sheet sampled triplanar by the painterly-vinyl
material (``buildVinylMaterial`` in ``src/engine/render/painterly-vinyl-material.ts``).

A 1024² grayscale sheet centred on mid-grey (128). The runtime reads ONE scalar
from it and derives BOTH a brightness modulation (albedo) and a bump/relief from
its gradient — exactly like the procedural ``streak`` field it replaces. So
mid-grey = no change (a true brush-0 no-op), brighter = raised bristle ridge,
darker = trough.

Deliberate tapered, flow-aligned strokes with bristle sub-lines give the bold,
hand-painted read the procedural value-noise can't. Seamless by construction:
every stroke is wrap-drawn at all 9 toroidal offsets, the flow field is periodic
in SIZE, and the softening blur runs on a 3×3 tiling then crops the centre — so
it tiles with no seam under triplanar world/object sampling.

Pure PIL, deterministic (seeded) — no Blender, no GPU. Re-runnable forever; mirror
the look-bible cousins ``build_decal_atlas.py`` / ``build_trim_sheets.py``.

Run:
    python tools/blender/build_brush_texture.py
    # or
    pnpm run gen:brush-texture
"""
from __future__ import annotations

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageStat

SIZE = 1024
SEED = 1107
N_STROKES = 170
BLUR = 1.5
ASSET_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "public", "assets", "textures", "brush_strokes.png",
)

# Toroidal offsets — drawing every stroke at all 9 makes anything crossing an
# edge reappear on the opposite side, so the sheet tiles seamlessly.
WRAP = [(dx * SIZE, dy * SIZE) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]


def _flow_angle(x: float, y: float) -> float:
    """Smooth low-frequency flow field so neighbouring strokes stay roughly
    parallel (reads as brushwork, not confetti). Built from integer-period sines
    so it is periodic in SIZE and tiles."""
    fx = x / SIZE * math.tau
    fy = y / SIZE * math.tau
    return (
        0.9 * math.sin(fx)
        + 0.6 * math.cos(fy * 2.0)
        + 0.5 * math.sin(fx + fy)
        + math.pi * 0.15
    )


def _stroke(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    ang: float,
    length: float,
    width: float,
    value: int,
    rng: random.Random,
) -> None:
    """One tapered, flow-aligned brush stroke + a few bristle sub-lines, drawn at
    all 9 wrap offsets. Tapered = filled discs whose radius swells then fades
    along the stroke axis (sin envelope); bristles = thin parallel scratches that
    run ALONG the stroke so it reads as bristle-work, not a blob."""
    ca, sa = math.cos(ang), math.sin(ang)
    px, py = -sa, ca  # perpendicular (bristle offset axis)
    steps = max(6, int(length / 6))
    for dx, dy in WRAP:
        for i in range(steps + 1):
            t = i / steps
            r = width * math.sin(math.pi * t) * 0.5 + 0.6
            ox = cx + (t - 0.5) * length * ca + dx
            oy = cy + (t - 0.5) * length * sa + dy
            draw.ellipse([ox - r, oy - r, ox + r, oy + r], fill=value)
        for _ in range(rng.randint(2, 4)):
            off = rng.uniform(-width * 0.4, width * 0.4)
            bv = max(0, min(255, value + rng.randint(-22, 22)))
            x0 = cx - 0.5 * length * ca + px * off + dx
            y0 = cy - 0.5 * length * sa + py * off + dy
            x1 = cx + 0.5 * length * ca + px * off + dx
            y1 = cy + 0.5 * length * sa + py * off + dy
            draw.line([x0, y0, x1, y1], fill=bv, width=1)


def build() -> None:
    rng = random.Random(SEED)
    canvas = Image.new("L", (SIZE, SIZE), 128)
    draw = ImageDraw.Draw(canvas)

    for _ in range(N_STROKES):
        cx = rng.uniform(0, SIZE)
        cy = rng.uniform(0, SIZE)
        ang = _flow_angle(cx, cy) + rng.uniform(-0.25, 0.25)
        length = rng.uniform(70, 190)
        width = rng.uniform(7, 20)
        # Brightness around mid-grey: a signed bristle ridge (+) or trough (-).
        value = 128 + rng.choice((-1, 1)) * rng.randint(28, 60)
        _stroke(draw, cx, cy, ang, length, width, value, rng)

    # Soften into brushwork. Blur on a 3×3 tiling + crop the centre so the blur
    # is itself seamless (PIL's GaussianBlur clamps at the border otherwise).
    tiled = Image.new("L", (SIZE * 3, SIZE * 3))
    for ty in range(3):
        for tx in range(3):
            tiled.paste(canvas, (tx * SIZE, ty * SIZE))
    tiled = tiled.filter(ImageFilter.GaussianBlur(BLUR))
    canvas = tiled.crop((SIZE, SIZE, SIZE * 2, SIZE * 2))

    # Recentre to mid-grey so the runtime's (streak - 0.5) stays balanced and a
    # brush amount of 0 remains a true no-op.
    mean = ImageStat.Stat(canvas).mean[0]
    shift = 128.0 - mean
    canvas = canvas.point(lambda v: int(max(0, min(255, v + shift))))

    out = Image.merge("RGB", (canvas, canvas, canvas))
    os.makedirs(os.path.dirname(ASSET_PATH), exist_ok=True)
    out.save(ASSET_PATH, "PNG", optimize=True)
    print(f"[brush-texture] wrote {ASSET_PATH} ({os.path.getsize(ASSET_PATH)} bytes)")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:  # noqa: BLE001
        print(f"[brush-texture] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
