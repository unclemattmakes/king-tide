"""Generate per-biome landmark trim sheets.

A *trim sheet* is a 1024 × 1024 texture packed into 8 horizontal strips,
each 1024 × 128. Per-face UVs on the landmark mesh map sub-strips of
geometry onto strips of the texture — one shared material covers every
landmark in a biome instead of N flat-coloured BSDFs.

Strip legend (consistent across biomes so authoring stays portable):

    Row 0 (top)   — window grid (dense small windows)
    Row 1         — narrow vertical signage / kanji slab
    Row 2         — horizontal accent / sign band
    Row 3         — concrete weathering streak
    Row 4         — brick / panel pattern
    Row 5         — neon glow strip (emissive)
    Row 6         — corner / ledge moulding
    Row 7         — flat dark base

This script ships a Shibuya / Tokyo-neon trim sheet today
(``public/assets/landmarks/trim_tokyo_neon.png``). Additional biome
sheets (Reef pastel, NYC granite, Venice ochre, …) are stubbed in the
generator dispatch so future passes drop-in without restructuring.

Run::

    python tools/blender/build_trim_sheets.py
    # or
    pnpm run gen:trim-sheets
"""
from __future__ import annotations

import math
import os
import random
import sys
from typing import Callable

from PIL import Image, ImageDraw, ImageFilter

SHEET_SIZE = 1024
STRIP_HEIGHT = SHEET_SIZE // 8   # 8 horizontal strips
ASSETS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "public", "assets", "landmarks",
)


# ────────────────────────────────────────────────────────────────────
# Painter primitives
# ────────────────────────────────────────────────────────────────────


def _fill(strip: Image.Image, rgba: tuple[int, int, int, int]) -> None:
    ImageDraw.Draw(strip).rectangle([0, 0, strip.width, strip.height], fill=rgba)


def _noise(strip: Image.Image, density: float = 0.04, alpha: int = 30) -> None:
    """Sprinkle 1px grain across the strip — dust / weathering hint."""
    d = ImageDraw.Draw(strip)
    n = int(strip.width * strip.height * density)
    rng = random.Random(0xC0FFEE)
    for _ in range(n):
        x = rng.randint(0, strip.width - 1)
        y = rng.randint(0, strip.height - 1)
        v = rng.randint(0, 255)
        d.point((x, y), fill=(v, v, v, alpha))


# ────────────────────────────────────────────────────────────────────
# Strip painters — Tokyo / Shibuya palette
# ────────────────────────────────────────────────────────────────────


def _tokyo_strip_0_windows(strip: Image.Image) -> None:
    """Dense rectangular windows on a dark wet-concrete background.
    Half lit (warm amber), half dark, randomly mixed."""
    _fill(strip, (32, 36, 44, 255))
    rng = random.Random(11)
    cols = 24
    rows = 4
    cell_w = strip.width / cols
    cell_h = strip.height / rows
    pad_x = cell_w * 0.18
    pad_y = cell_h * 0.18
    d = ImageDraw.Draw(strip)
    for r in range(rows):
        for c in range(cols):
            x0 = c * cell_w + pad_x
            y0 = r * cell_h + pad_y
            x1 = (c + 1) * cell_w - pad_x
            y1 = (r + 1) * cell_h - pad_y
            lit = rng.random() < 0.55
            if lit:
                # Warm amber pane with slight per-window variance.
                v = rng.randint(220, 255)
                d.rectangle([x0, y0, x1, y1], fill=(v, v - 30, 130, 255))
            else:
                d.rectangle([x0, y0, x1, y1], fill=(48, 56, 64, 255))


def _tokyo_strip_1_kanji(strip: Image.Image) -> None:
    """Vertical kanji-style stack — a hot magenta column of glyph
    silhouettes on dark teal. Glyphs are abstract geometric blocks
    that *read* as character composition at race speed without being
    real characters."""
    _fill(strip, (18, 22, 30, 255))
    d = ImageDraw.Draw(strip)
    # Reserve a vertical kanji column on the left third.
    col_x0 = int(strip.width * 0.02)
    col_x1 = int(strip.width * 0.18)
    d.rectangle([col_x0, 0, col_x1, strip.height], fill=(80, 12, 50, 255))
    rng = random.Random(22)
    block_h = strip.height // 3
    for i in range(3):
        y0 = i * block_h + 8
        y1 = (i + 1) * block_h - 8
        # Two crossing bars per "glyph" + a vertical accent.
        d.rectangle([col_x0 + 6, y0 + (y1 - y0) // 3 - 4,
                     col_x1 - 6, y0 + (y1 - y0) // 3 + 4],
                    fill=(255, 80, 200, 255))
        d.rectangle([col_x0 + (col_x1 - col_x0) // 2 - 3, y0 + 4,
                     col_x0 + (col_x1 - col_x0) // 2 + 3, y1 - 4],
                    fill=(255, 80, 200, 255))
        # One short diagonal accent — fake stroke.
        diag_y = y0 + (y1 - y0) * 2 // 3
        d.line([(col_x0 + 4, diag_y), (col_x1 - 4, diag_y + 6)],
               fill=(255, 80, 200, 255), width=3)
    # Rest of the strip: glow gradient (suggesting the sign's halo).
    for x in range(col_x1, strip.width):
        t = (x - col_x1) / max(1, (strip.width - col_x1))
        a = int(180 * (1.0 - t) ** 1.4)
        d.line([(x, 0), (x, strip.height)], fill=(255, 80, 200, a))


def _tokyo_strip_2_signage(strip: Image.Image) -> None:
    """Horizontal accent / sign band — broad backlit panel."""
    _fill(strip, (10, 12, 16, 255))
    d = ImageDraw.Draw(strip)
    # Bright panel covering most of the strip.
    panel_y = strip.height // 4
    panel_h = strip.height // 2
    d.rectangle([0, panel_y, strip.width, panel_y + panel_h], fill=(40, 200, 230, 255))
    # Pseudo-text dashes along the panel.
    rng = random.Random(33)
    dash_x = 30
    while dash_x < strip.width - 60:
        w = rng.randint(40, 110)
        d.rectangle([dash_x, panel_y + 10, dash_x + w, panel_y + panel_h - 10],
                    fill=(255, 240, 220, 255))
        dash_x += w + rng.randint(18, 40)


def _tokyo_strip_3_weathering(strip: Image.Image) -> None:
    """Vertical concrete weathering streaks — what rain leaves on a
    skyscraper face. Procedural so the strip tiles vertically."""
    _fill(strip, (90, 92, 96, 255))
    _noise(strip, density=0.10, alpha=22)
    d = ImageDraw.Draw(strip)
    rng = random.Random(44)
    for _ in range(28):
        x = rng.randint(0, strip.width - 1)
        w = rng.randint(2, 8)
        a = rng.randint(40, 120)
        # Streak fades from top to bottom — top is the source (a window
        # ledge, in author's head), the streak weakens as it falls.
        for y in range(strip.height):
            ay = int(a * (1.0 - y / strip.height))
            d.rectangle([x, y, x + w, y + 1], fill=(40, 40, 42, ay))


def _tokyo_strip_4_brick(strip: Image.Image) -> None:
    """Tiled brick / panel pattern — running-bond bricks."""
    _fill(strip, (74, 60, 52, 255))
    d = ImageDraw.Draw(strip)
    brick_w = 64
    brick_h = 24
    for ri in range(strip.height // brick_h + 2):
        y = ri * brick_h
        x_offset = (brick_w // 2) if (ri % 2) else 0
        for ci in range(-1, strip.width // brick_w + 2):
            x = ci * brick_w + x_offset
            d.rectangle([x + 2, y + 2, x + brick_w - 2, y + brick_h - 2],
                        fill=(108, 88, 72, 255))
            d.line([x + 2, y + 2, x + brick_w - 2, y + 2],
                   fill=(140, 110, 90, 255), width=1)


def _tokyo_strip_5_neon(strip: Image.Image) -> None:
    """Emissive neon ribbon — a thin bright magenta strip on black,
    with a soft glow halo. Reads as a roof-edge neon trim from 40 m."""
    _fill(strip, (8, 8, 12, 255))
    d = ImageDraw.Draw(strip)
    # Main glowing line down the middle.
    mid_y = strip.height // 2
    line_h = 12
    d.rectangle([0, mid_y - line_h // 2, strip.width, mid_y + line_h // 2],
                fill=(255, 80, 200, 255))
    # Glow halo.
    halo_h = 36
    for y in range(mid_y - halo_h, mid_y + halo_h + 1):
        dist = abs(y - mid_y)
        if dist <= line_h // 2:
            continue
        a = int(200 * (1.0 - (dist - line_h // 2) / halo_h) ** 2)
        d.line([(0, y), (strip.width, y)], fill=(255, 80, 200, a))


def _tokyo_strip_6_ledge(strip: Image.Image) -> None:
    """Corner / ledge moulding — a darker horizontal slab with cast
    shadow on the side opposite the light. Used along setback edges
    on skyscraper facades."""
    _fill(strip, (44, 48, 56, 255))
    d = ImageDraw.Draw(strip)
    # Ledge top — bright highlight (sun-lit edge).
    d.rectangle([0, 8, strip.width, 22], fill=(140, 144, 150, 255))
    # Drop shadow underneath the ledge.
    for y in range(22, 60):
        a = max(0, 180 - (y - 22) * 5)
        d.line([(0, y), (strip.width, y)], fill=(0, 0, 0, a))


def _tokyo_strip_7_base(strip: Image.Image) -> None:
    """Flat dark concrete base — for any face that doesn't need its
    own treatment. Slight gradient + grain so it doesn't read as flat
    plastic."""
    rng = random.Random(77)
    d = ImageDraw.Draw(strip)
    for y in range(strip.height):
        v = 28 + int(8 * math.sin(y / strip.height * math.pi))
        d.line([(0, y), (strip.width, y)], fill=(v, v + 2, v + 6, 255))
    _noise(strip, density=0.08, alpha=18)


_TOKYO_PAINTERS: tuple[Callable[[Image.Image], None], ...] = (
    _tokyo_strip_0_windows,
    _tokyo_strip_1_kanji,
    _tokyo_strip_2_signage,
    _tokyo_strip_3_weathering,
    _tokyo_strip_4_brick,
    _tokyo_strip_5_neon,
    _tokyo_strip_6_ledge,
    _tokyo_strip_7_base,
)


def _compose_sheet(painters: tuple[Callable[[Image.Image], None], ...]) -> Image.Image:
    sheet = Image.new("RGBA", (SHEET_SIZE, SHEET_SIZE), (0, 0, 0, 255))
    for i, paint in enumerate(painters):
        strip = Image.new("RGBA", (SHEET_SIZE, STRIP_HEIGHT), (0, 0, 0, 255))
        paint(strip)
        sheet.paste(strip, (0, i * STRIP_HEIGHT))
    # Final soft blur across strip seams to avoid hard 1-px lines under
    # mipmapping. 0.8 px is enough to soften seams without smearing
    # in-strip detail visibly at race speed.
    sheet = sheet.filter(ImageFilter.GaussianBlur(0.4))
    return sheet


def build_tokyo_sheet() -> None:
    sheet = _compose_sheet(_TOKYO_PAINTERS)
    out_path = os.path.join(ASSETS_DIR, "trim_tokyo_neon.png")
    os.makedirs(ASSETS_DIR, exist_ok=True)
    sheet.save(out_path, "PNG", optimize=True)
    print(f"[trim-sheets] wrote {out_path} ({os.path.getsize(out_path)} bytes)")


# Future biome sheets land here — same composer, different painter set.
_BIOMES = {
    "tokyo_neon": build_tokyo_sheet,
}


def main() -> None:
    for name, build in _BIOMES.items():
        try:
            build()
        except Exception as e:  # noqa: BLE001
            print(f"[trim-sheets] FAILED for {name}: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
