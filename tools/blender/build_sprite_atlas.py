"""Build the shared particle sprite atlas at
``public/assets/fx/particle-atlas.png``.

The runtime particle system (``src/engine/render/particle-system.ts``)
reads from a single 1024x1024 RGBA PNG split into a 4x4 grid of 256x256
cells. Each ``kind=emitter`` empty picks an ``atlas_cell`` index
(0..15) and the SpriteNodeMaterial samples the matching tile via UV
offsetting.

We generate the atlas procedurally here — no real artwork yet, just
math + Pillow drawing primitives. Each cell is hand-tuned to read at
the typical 0.5-3 m world size the runtime renders particles at.

Cell index reference (mirrored as a comment in the runtime particle
system):

    0  soft round spark      — radial gradient, white centre → transparent
    1  smoke puff            — low-freq noise, gray, soft edges
    2  ember                 — radial gradient, orange centre, fading
    3  foam droplet          — radial gradient, white, harder edge
    4  dust mote             — small soft round
    5  gull silhouette       — V-shape, thresholded
    6  leaf                  — oval, green
    7  neon glare            — cross-shaped streaks
    8  ash                   — small grey speck with soft halo
    9  water spray           — vertical streak, white
   10  glow halo             — large soft round, bloom-ready
   11  motion streak         — horizontal streak, white
   12  spare (alias of 0)    — soft round spark
   13  spare (alias of 1)    — smoke puff
   14  spare (alias of 2)    — ember
   15  spare (alias of 3)    — foam droplet

Run:
    pnpm gen:fx-atlas
or directly:
    python tools/blender/build_sprite_atlas.py

Pillow is the only dependency. Idempotent — overwrites the output PNG
on every run with deterministic pixels.
"""

from __future__ import annotations

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

ATLAS_SIZE = 1024
GRID = 4  # 4x4 = 16 cells
CELL = ATLAS_SIZE // GRID  # 256

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
_DEFAULT_OUT = os.path.join(_REPO_ROOT, "public", "assets", "fx", "particle-atlas.png")


# ────────────────────────────────────────────────────────────────────
# Cell-drawing primitives
# ────────────────────────────────────────────────────────────────────


def _radial_gradient(
    size: int,
    rgb: tuple[int, int, int],
    *,
    inner_alpha: int = 255,
    falloff: float = 1.0,
    hard_edge: float = 0.0,
) -> Image.Image:
    """Build a radial gradient from the centre. ``falloff`` controls the
    decay curve (1 = quadratic, >1 = sharper centre, <1 = softer).
    ``hard_edge`` in [0,1] biases the alpha toward stay-opaque longer
    before falling off (foam droplet vs. soft spark)."""
    img = Image.new("RGBA", (size, size), (rgb[0], rgb[1], rgb[2], 0))
    pixels = img.load()
    cx = cy = size / 2
    max_r = size / 2
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            r = math.sqrt(dx * dx + dy * dy) / max_r
            if r >= 1:
                continue
            # Optionally hold full alpha out to `hard_edge` of the
            # radius, then fall off.
            if hard_edge > 0 and r < hard_edge:
                a = inner_alpha
            else:
                # Remap r so the falloff begins at hard_edge.
                rr = (r - hard_edge) / max(1e-3, 1 - hard_edge)
                a_norm = max(0.0, 1.0 - rr) ** (2.0 * falloff)
                a = int(inner_alpha * a_norm)
            pixels[x, y] = (rgb[0], rgb[1], rgb[2], a)
    return img


def _value_noise_2d(size: int, *, octaves: int, seed: int) -> list[list[float]]:
    """Tiny value-noise heightfield in [0, 1]. Used for smoke puff
    interiors. Deterministic seed → reproducible atlas across runs."""
    rng = random.Random(seed)
    out = [[0.0] * size for _ in range(size)]
    amp = 1.0
    amp_sum = 0.0
    for o in range(octaves):
        cell = max(2, size >> o)
        cols = size // cell + 2
        rows = size // cell + 2
        grid = [[rng.random() for _ in range(cols)] for _ in range(rows)]
        for y in range(size):
            fy = y / cell
            iy = int(fy)
            ty = fy - iy
            ty = ty * ty * (3 - 2 * ty)
            for x in range(size):
                fx = x / cell
                ix = int(fx)
                tx = fx - ix
                tx = tx * tx * (3 - 2 * tx)
                v00 = grid[iy][ix]
                v10 = grid[iy][ix + 1]
                v01 = grid[iy + 1][ix]
                v11 = grid[iy + 1][ix + 1]
                a = v00 * (1 - tx) + v10 * tx
                b = v01 * (1 - tx) + v11 * tx
                out[y][x] += amp * (a * (1 - ty) + b * ty)
        amp_sum += amp
        amp *= 0.5
    if amp_sum > 0:
        for y in range(size):
            for x in range(size):
                out[y][x] /= amp_sum
    return out


def _cell_soft_spark() -> Image.Image:
    """Cell 0 — soft round spark. White, radial fade, slight bloom feel."""
    img = _radial_gradient(CELL, (255, 255, 255), inner_alpha=255, falloff=1.2)
    return img.filter(ImageFilter.GaussianBlur(radius=2))


def _cell_smoke_puff() -> Image.Image:
    """Cell 1 — smoke puff. Soft gray cloud with low-freq noise interior."""
    noise = _value_noise_2d(CELL, octaves=4, seed=11)
    cx = cy = CELL / 2
    max_r = CELL / 2
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    pixels = img.load()
    for y in range(CELL):
        for x in range(CELL):
            dx = x - cx
            dy = y - cy
            r = math.sqrt(dx * dx + dy * dy) / max_r
            if r >= 1:
                continue
            shape = max(0.0, 1.0 - r) ** 1.6
            density = 0.4 + 0.6 * noise[y][x]
            a = int(220 * shape * density)
            v = int(190 + 40 * noise[y][x])
            pixels[x, y] = (v, v, v, a)
    return img.filter(ImageFilter.GaussianBlur(radius=3))


def _cell_ember() -> Image.Image:
    """Cell 2 — ember. Hot-orange centre fading through red to transparent."""
    cx = cy = CELL / 2
    max_r = CELL / 2
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    pixels = img.load()
    for y in range(CELL):
        for x in range(CELL):
            dx = x - cx
            dy = y - cy
            r = math.sqrt(dx * dx + dy * dy) / max_r
            if r >= 1:
                continue
            t = max(0.0, 1.0 - r)
            # White-hot core → orange → deep red
            if t > 0.75:
                rc, gc, bc = 255, 245, 200
            elif t > 0.45:
                rc, gc, bc = 255, 170, 60
            else:
                rc, gc, bc = 220, 70, 20
            a = int(255 * (t**1.3))
            pixels[x, y] = (rc, gc, bc, a)
    return img.filter(ImageFilter.GaussianBlur(radius=1.5))


def _cell_foam_droplet() -> Image.Image:
    """Cell 3 — foam droplet. White, slightly harder edge than soft spark."""
    img = _radial_gradient(
        CELL, (250, 252, 255), inner_alpha=255, falloff=0.9, hard_edge=0.35
    )
    return img.filter(ImageFilter.GaussianBlur(radius=1.4))


def _cell_dust_mote() -> Image.Image:
    """Cell 4 — small dust mote. Pale tan, gentle fade."""
    # Half-size dot centered in the cell so the mote reads "small."
    src = _radial_gradient(CELL // 2, (210, 196, 170), inner_alpha=235, falloff=1.4)
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    out.paste(src, (CELL // 4, CELL // 4), src)
    return out.filter(ImageFilter.GaussianBlur(radius=2))


def _cell_gull_silhouette() -> Image.Image:
    """Cell 5 — distant gull V-shape. Dark grey silhouette over alpha."""
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = CELL / 2
    cy = CELL / 2
    span = CELL * 0.38
    rise = CELL * 0.18
    # Two wing strokes meeting at the body — a basic distant-bird "M" curve.
    thickness = int(CELL * 0.04)
    # Left wing arc: three control points.
    draw.line(
        [
            (cx - span, cy + rise * 0.4),
            (cx - span * 0.35, cy - rise * 0.4),
            (cx, cy),
        ],
        fill=(40, 50, 60, 235),
        width=thickness,
        joint="curve",
    )
    # Right wing arc: mirrored.
    draw.line(
        [
            (cx, cy),
            (cx + span * 0.35, cy - rise * 0.4),
            (cx + span, cy + rise * 0.4),
        ],
        fill=(40, 50, 60, 235),
        width=thickness,
        joint="curve",
    )
    return img.filter(ImageFilter.GaussianBlur(radius=1.2))


def _cell_leaf() -> Image.Image:
    """Cell 6 — leaf. Green oval with a darker midrib."""
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = CELL * 0.15
    # Oblong leaf.
    draw.ellipse(
        (pad * 1.8, pad, CELL - pad * 1.8, CELL - pad),
        fill=(90, 150, 60, 230),
        outline=(60, 110, 40, 250),
        width=2,
    )
    # Midrib running top-to-bottom.
    draw.line(
        [(CELL / 2, pad * 1.1), (CELL / 2, CELL - pad * 1.1)],
        fill=(55, 100, 35, 220),
        width=2,
    )
    return img.filter(ImageFilter.GaussianBlur(radius=0.8))


def _cell_neon_glare() -> Image.Image:
    """Cell 7 — neon glare cross. Bright cross of streaks + a central hot core."""
    img = _radial_gradient(CELL, (200, 240, 255), inner_alpha=160, falloff=1.6)
    draw = ImageDraw.Draw(img)
    cx = CELL // 2
    cy = CELL // 2
    # Horizontal + vertical streaks.
    streak = int(CELL * 0.06)
    draw.rectangle(
        (0, cy - streak // 2, CELL, cy + streak // 2),
        fill=(255, 255, 255, 200),
    )
    draw.rectangle(
        (cx - streak // 2, 0, cx + streak // 2, CELL),
        fill=(255, 255, 255, 200),
    )
    img = img.filter(ImageFilter.GaussianBlur(radius=3))
    # Restore a tight core after the blur softens everything.
    core = _radial_gradient(CELL // 3, (255, 255, 255), inner_alpha=255, falloff=1.0)
    img.alpha_composite(core, (CELL // 3, CELL // 3))
    return img


def _cell_ash() -> Image.Image:
    """Cell 8 — ash speck. Small dark dot with soft halo."""
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    halo = _radial_gradient(CELL, (95, 92, 88), inner_alpha=90, falloff=2.2)
    out.alpha_composite(halo)
    core = _radial_gradient(CELL // 4, (45, 45, 50), inner_alpha=240, falloff=0.9)
    out.alpha_composite(core, ((CELL - CELL // 4) // 2, (CELL - CELL // 4) // 2))
    return out.filter(ImageFilter.GaussianBlur(radius=1.4))


def _cell_water_spray() -> Image.Image:
    """Cell 9 — vertical white streak. Tall, narrow, soft-ended."""
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cx = CELL / 2
    half_w = CELL * 0.08
    for y in range(CELL):
        # Bell-shape along Y: brightest at the middle, fades to zero at ends.
        ty = abs(y - CELL / 2) / (CELL / 2)
        a_y = max(0.0, 1.0 - ty * 1.05) ** 1.4
        for x in range(int(cx - half_w * 2), int(cx + half_w * 2) + 1):
            tx = abs(x - cx) / half_w
            a_x = max(0.0, 1.0 - tx) ** 1.8
            a = int(255 * a_x * a_y)
            if a > 0:
                img.putpixel((x, y), (245, 248, 255, a))
    return img.filter(ImageFilter.GaussianBlur(radius=1.6))


def _cell_glow_halo() -> Image.Image:
    """Cell 10 — large soft round, bloom-ready. Brighter centre,
    very long falloff for additive blending."""
    img = _radial_gradient(CELL, (255, 250, 230), inner_alpha=200, falloff=0.55)
    return img.filter(ImageFilter.GaussianBlur(radius=4))


def _cell_motion_streak() -> Image.Image:
    """Cell 11 — horizontal white streak (rotation gives lateral motion lines)."""
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cy = CELL / 2
    half_h = CELL * 0.06
    for x in range(CELL):
        # Bell along X.
        tx = abs(x - CELL / 2) / (CELL / 2)
        a_x = max(0.0, 1.0 - tx * 1.05) ** 1.4
        for y in range(int(cy - half_h * 2), int(cy + half_h * 2) + 1):
            ty = abs(y - cy) / half_h
            a_y = max(0.0, 1.0 - ty) ** 1.8
            a = int(255 * a_x * a_y)
            if a > 0:
                img.putpixel((x, y), (250, 250, 252, a))
    return img.filter(ImageFilter.GaussianBlur(radius=1.4))


# Cells 12-15: spares. Currently aliased to the four most-reused early
# cells so a stray atlas_cell index is still legible during authoring.
_CELL_BUILDERS = {
    0: _cell_soft_spark,
    1: _cell_smoke_puff,
    2: _cell_ember,
    3: _cell_foam_droplet,
    4: _cell_dust_mote,
    5: _cell_gull_silhouette,
    6: _cell_leaf,
    7: _cell_neon_glare,
    8: _cell_ash,
    9: _cell_water_spray,
    10: _cell_glow_halo,
    11: _cell_motion_streak,
    12: _cell_soft_spark,
    13: _cell_smoke_puff,
    14: _cell_ember,
    15: _cell_foam_droplet,
}


# ────────────────────────────────────────────────────────────────────
# Composition
# ────────────────────────────────────────────────────────────────────


def build_atlas() -> Image.Image:
    atlas = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    for idx in range(GRID * GRID):
        col = idx % GRID
        row = idx // GRID
        builder = _CELL_BUILDERS.get(idx)
        if builder is None:
            continue
        cell_img = builder()
        if cell_img.size != (CELL, CELL):
            cell_img = cell_img.resize((CELL, CELL), Image.LANCZOS)
        atlas.alpha_composite(cell_img, (col * CELL, row * CELL))
    return atlas


def main(out_path: str = _DEFAULT_OUT) -> str:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    atlas = build_atlas()
    atlas.save(out_path, format="PNG", optimize=True)
    return out_path


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT_OUT
    written = main(target)
    print(f"wrote {written} ({ATLAS_SIZE}x{ATLAS_SIZE}, {GRID}x{GRID} cells)")
