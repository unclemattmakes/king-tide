"""Generate ``public/assets/decals/atlas.png`` — the shared decal atlas.

A 1024 × 1024 RGBA PNG packed as a 4 × 4 grid of 256 × 256 cells. Each
cell carries one decal pattern (road wear streak, lane stripe, oil
stain, etc.). The runtime ``decal-system.ts`` samples a cell via the
quad's UVs (a Blender-side ``atlas_cell`` extra of 0..15 picks the cell;
the addon's *Add Decal* operator UV-unwraps the quad onto the right
tile).

The patterns are intentionally procedural / grayscale so authors can
re-tint per-decal via a material colour multiplier. A real artist
texture replaces this file as Phase δ matures.

Run:
    python tools/blender/build_decal_atlas.py
    # or
    pnpm run gen:decals

No Blender dependency — pure PIL.
"""
from __future__ import annotations

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

ATLAS_SIZE = 1024
CELL_SIZE = 256
GRID = ATLAS_SIZE // CELL_SIZE  # 4 cells per axis = 16 total
ASSET_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "public", "assets", "decals", "atlas.png",
)

# Cell legend — mirror in ``src/engine/render/decal-system.ts``. A future
# CI check can grep both sides; for now the docstrings hold the contract.
CELL_LEGEND: tuple[str, ...] = (
    "0 road-wear streak",
    "1 lane stripe",
    "2 fade line",
    "3 oil stain",
    "4 water splash",
    "5 graffiti tag",
    "6 sponsor poster",
    "7 crack web",
    "8 moss patch",
    "9 neon-reflection puddle",
    "10 tire skid",
    "11 paint smear",
    "12 corner-exit smear",
    "13 leaked fluid pool",
    "14 burn mark",
    "15 chalk arrow",
)


def _smooth_radial(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: float, alpha: int) -> None:
    """Filled circle with feathered edge — simulated by stacking shrinking
    discs at decreasing opacity. Cheap and reads fine at race speed."""
    layers = 10
    for i in range(layers):
        t = i / (layers - 1)
        rr = r * (1.0 - t * 0.55)
        a = int(alpha * (1.0 - t) ** 1.6)
        if a <= 0:
            continue
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 255, 255, a))


def _draw_cell(cell_idx: int, dst: Image.Image, x: int, y: int) -> None:
    """Stamp the pattern for ``cell_idx`` into the ``CELL_SIZE`` × ``CELL_SIZE``
    region at ``(x, y)`` on ``dst``. Each branch is a small standalone
    bmp painter — keeping them inline avoids one helper file per cell."""
    cell = Image.new("RGBA", (CELL_SIZE, CELL_SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(cell)
    rng = random.Random(cell_idx * 9973 + 17)

    if cell_idx == 0:  # road-wear streak — horizontal bands of darker grey
        for i in range(40):
            y0 = rng.randint(0, CELL_SIZE - 1)
            w = rng.randint(40, 180)
            alpha = rng.randint(40, 120)
            x0 = rng.randint(0, CELL_SIZE - w)
            d.rectangle([x0, y0, x0 + w, y0 + 2], fill=(220, 220, 220, alpha))

    elif cell_idx == 1:  # lane stripe — bright white strip down the middle
        mid = CELL_SIZE // 2
        d.rectangle([mid - 16, 0, mid + 16, CELL_SIZE], fill=(255, 255, 255, 230))
        # Slight noisy fade at the edges
        for x_ in range(mid - 32, mid - 16):
            a = int(230 * (x_ - (mid - 32)) / 16)
            d.rectangle([x_, 0, x_ + 1, CELL_SIZE], fill=(255, 255, 255, a))
        for x_ in range(mid + 16, mid + 32):
            a = int(230 * (1.0 - (x_ - (mid + 16)) / 16))
            d.rectangle([x_, 0, x_ + 1, CELL_SIZE], fill=(255, 255, 255, a))

    elif cell_idx == 2:  # fade line — same as lane stripe but heavily eroded
        mid = CELL_SIZE // 2
        for y_ in range(CELL_SIZE):
            keep = rng.random() > 0.35
            if not keep:
                continue
            a = rng.randint(60, 200)
            w = rng.randint(8, 24)
            d.rectangle([mid - w, y_, mid + w, y_ + 1], fill=(240, 240, 240, a))

    elif cell_idx == 3:  # oil stain — dark blob with feathered alpha
        cx = CELL_SIZE // 2 + rng.randint(-20, 20)
        cy = CELL_SIZE // 2 + rng.randint(-20, 20)
        # Solid dark base; alpha mask painted separately so we can
        # feather without losing the dark tint.
        cell = Image.new("RGBA", (CELL_SIZE, CELL_SIZE), (40, 35, 30, 0))
        mask = Image.new("L", (CELL_SIZE, CELL_SIZE), 0)
        md = ImageDraw.Draw(mask)
        # Mask version of _smooth_radial: stack shrinking discs in
        # grayscale rather than RGBA so we don't pass tuples to an L-mode draw.
        layers = 10
        for i in range(layers):
            t = i / (layers - 1)
            rr = CELL_SIZE * 0.42 * (1.0 - t * 0.55)
            a = int(220 * (1.0 - t) ** 1.6)
            if a <= 0:
                continue
            md.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=a)
        cell.putalpha(mask)
        d = ImageDraw.Draw(cell)  # re-bind so subsequent branches stay valid

    elif cell_idx == 4:  # water splash — radial bright spots
        for _ in range(12):
            sx = rng.randint(20, CELL_SIZE - 20)
            sy = rng.randint(20, CELL_SIZE - 20)
            r = rng.randint(10, 35)
            a = rng.randint(60, 180)
            d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(240, 250, 255, a))
        cell = cell.filter(ImageFilter.GaussianBlur(2.0))

    elif cell_idx == 5:  # graffiti tag — chunky overlapping rectangles
        for _ in range(7):
            x0 = rng.randint(20, CELL_SIZE - 80)
            y0 = rng.randint(60, CELL_SIZE - 60)
            w = rng.randint(40, 100)
            h = rng.randint(20, 50)
            c = rng.choice([(255, 80, 80), (80, 200, 255), (255, 230, 80), (255, 120, 220)])
            d.rectangle([x0, y0, x0 + w, y0 + h], fill=(*c, 220))

    elif cell_idx == 6:  # sponsor poster — rectangular block with frame
        d.rectangle([20, 30, CELL_SIZE - 20, CELL_SIZE - 30], fill=(240, 240, 235, 230))
        d.rectangle([20, 30, CELL_SIZE - 20, CELL_SIZE - 30], outline=(30, 30, 30, 255), width=6)
        # Two horizontal bars suggesting text rows
        d.rectangle([60, 90, CELL_SIZE - 60, 130], fill=(30, 30, 30, 220))
        d.rectangle([60, 160, CELL_SIZE - 60, 180], fill=(70, 70, 70, 200))
        d.rectangle([60, 200, CELL_SIZE - 100, 220], fill=(70, 70, 70, 200))

    elif cell_idx == 7:  # crack web — thin lines radiating from centre
        cx = CELL_SIZE // 2
        cy = CELL_SIZE // 2
        for _ in range(28):
            ang = rng.uniform(0, math.tau)
            length = rng.randint(40, 120)
            ex = cx + int(math.cos(ang) * length)
            ey = cy + int(math.sin(ang) * length)
            d.line([cx, cy, ex, ey], fill=(20, 20, 20, 230), width=2)
            # Optional one-step branch
            if rng.random() < 0.5:
                bx = cx + int(math.cos(ang) * length * 0.6)
                by = cy + int(math.sin(ang) * length * 0.6)
                bang = ang + rng.uniform(-0.6, 0.6)
                bex = bx + int(math.cos(bang) * length * 0.4)
                bey = by + int(math.sin(bang) * length * 0.4)
                d.line([bx, by, bex, bey], fill=(20, 20, 20, 200), width=2)

    elif cell_idx == 8:  # moss patch — soft green blobs
        for _ in range(30):
            sx = rng.randint(0, CELL_SIZE)
            sy = rng.randint(0, CELL_SIZE)
            r = rng.randint(15, 50)
            a = rng.randint(50, 130)
            d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(60, 110, 50, a))
        cell = cell.filter(ImageFilter.GaussianBlur(4.0))

    elif cell_idx == 9:  # neon-reflection puddle — colourful gradient blob
        cx = CELL_SIZE // 2
        cy = CELL_SIZE // 2
        for r, c in [(110, (200, 60, 220, 180)), (80, (60, 200, 230, 180)),
                     (50, (255, 230, 80, 180)), (20, (255, 255, 255, 220))]:
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
        cell = cell.filter(ImageFilter.GaussianBlur(3.0))

    elif cell_idx == 10:  # tire skid — pair of parallel black streaks
        for offset in (-40, 40):
            xs = CELL_SIZE // 2 + offset
            for y_ in range(20, CELL_SIZE - 20):
                a = int(180 * (1.0 - abs(y_ - CELL_SIZE / 2) / (CELL_SIZE / 2)))
                a = max(30, min(220, a + rng.randint(-30, 30)))
                d.rectangle([xs - 8, y_, xs + 8, y_ + 1], fill=(15, 15, 15, a))

    elif cell_idx == 11:  # paint smear — angled bright streak
        for _ in range(200):
            t = rng.random()
            cx = int(60 + t * (CELL_SIZE - 120))
            cy = int(80 + t * (CELL_SIZE - 160))
            r = rng.randint(6, 18)
            a = rng.randint(80, 200)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(240, 80, 60, a))
        cell = cell.filter(ImageFilter.GaussianBlur(1.0))

    elif cell_idx == 12:  # corner-exit smear — fade from one corner
        for y_ in range(CELL_SIZE):
            for x_step in range(0, CELL_SIZE, 4):
                # Falloff from (0,0) corner
                dist = math.hypot(x_step, y_)
                a = int(max(0, 200 - dist * 1.0))
                if a > 0 and rng.random() > 0.3:
                    d.rectangle([x_step, y_, x_step + 4, y_ + 1], fill=(40, 30, 25, a))

    elif cell_idx == 13:  # leaked fluid pool — irregular pool
        # Build an irregular polygon
        n = 24
        cx = CELL_SIZE // 2
        cy = CELL_SIZE // 2
        pts: list[tuple[int, int]] = []
        for i in range(n):
            ang = i / n * math.tau
            r = CELL_SIZE * 0.32 * (0.7 + rng.random() * 0.6)
            pts.append((int(cx + math.cos(ang) * r), int(cy + math.sin(ang) * r)))
        d.polygon(pts, fill=(20, 60, 40, 220))
        cell = cell.filter(ImageFilter.GaussianBlur(2.5))

    elif cell_idx == 14:  # burn mark — dark scorched ellipse with bright edge
        cx = CELL_SIZE // 2
        cy = CELL_SIZE // 2
        d.ellipse([cx - 90, cy - 70, cx + 90, cy + 70], fill=(15, 10, 8, 230))
        d.ellipse([cx - 96, cy - 76, cx + 96, cy + 76], outline=(220, 130, 60, 200), width=4)
        cell = cell.filter(ImageFilter.GaussianBlur(3.0))

    elif cell_idx == 15:  # chalk arrow — directional triangle + tail
        # Pointing in +X direction across the cell
        cy = CELL_SIZE // 2
        # Tail
        d.rectangle([40, cy - 10, 180, cy + 10], fill=(250, 250, 240, 220))
        # Arrowhead
        d.polygon([(180, cy - 36), (180, cy + 36), (220, cy)], fill=(250, 250, 240, 240))
        cell = cell.filter(ImageFilter.GaussianBlur(0.8))

    dst.paste(cell, (x, y), cell)


def build_atlas() -> None:
    img = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    for idx in range(GRID * GRID):
        gx = idx % GRID
        gy = idx // GRID
        _draw_cell(idx, img, gx * CELL_SIZE, gy * CELL_SIZE)
    os.makedirs(os.path.dirname(ASSET_PATH), exist_ok=True)
    img.save(ASSET_PATH, "PNG", optimize=True)
    print(f"[decal-atlas] wrote {ASSET_PATH} ({os.path.getsize(ASSET_PATH)} bytes)")


if __name__ == "__main__":
    try:
        build_atlas()
    except Exception as e:  # noqa: BLE001
        print(f"[decal-atlas] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
