"""Generate ``public/assets/textures/brush_strokes.png`` — the shared, seamless,
painterly brush-stroke HEIGHT sheet sampled triplanar by the painterly-vinyl
material (``buildVinylMaterial`` in ``src/engine/render/painterly-vinyl-material.ts``).

A 1024² sheet that packs **three stroke SCALES into the R/G/B channels**:

    R = coarse  (few long sweeping strokes — reads on big set-pieces/cliffs)
    G = medium  (the default mid strokes)
    B = fine    (many short dabs — reads on small props)

Each channel is an independent grayscale HEIGHT field centred on mid-grey (128),
so the runtime can blend the three by prop size and the result still sits on 128
— i.e. a brush amount of 0 stays a true no-op. The runtime reads ONE texel and
derives BOTH a brightness modulation (albedo) and a bump/relief from the combined
scalar. A grayscale sheet (R=G=B) or the 1×1 fallback degrades to single-field
behaviour automatically, so this change is backward-compatible.

Strokes are real **bristle-brush** marks, not filled ellipses: a loaded tapered
body plus jittered bristle scratches that run ALONG the stroke and break up
(dry-brush) toward the trailing end, on a gently arced spine. They are flow-aligned
so neighbours stay roughly parallel (reads as brushwork, not confetti), and
composited by additive scatter with TOROIDAL WRAP — every mark that crosses an
edge reappears on the opposite side, so the sheet tiles seamlessly under the
triplanar world/object sampling with no blur-crop step.

Deterministic (seeded), pure NumPy + PIL — no Blender, no GPU. Re-runnable forever;
mirror the look-bible cousins ``build_decal_atlas.py`` / ``build_trim_sheets.py``.

Real painted media: drop grayscale stroke-alpha PNGs (128 = transparent) into
``tools/blender/brush_stamps/`` and they are composited instead of the procedural
bristles — the hook for scanned oil strokes (e.g. harvested from Blender's
Brushstroke Tools styles) or hand-painted ones. None present → procedural default.

Run:
    python tools/blender/build_brush_texture.py
    # or
    pnpm run gen:brush-texture
"""
from __future__ import annotations

import glob
import math
import os
import random
import sys

import numpy as np
from PIL import Image

SIZE = 1024
SEED = 1107
# Per-channel target contrast (std around mid-grey) so the three packed scales are
# comparable in amplitude regardless of stroke count — the runtime blend then
# behaves predictably as the weights shift with prop size.
TARGET_STD = 34.0

# (R, G, B) = (coarse, medium, fine). Each tuple-range is sampled per stroke.
# Counts are deliberately LOW: the real-oil stamps are high-coverage, so packing
# many of them blends into a smooth mush instead of distinct marks. Few + large +
# high-contrast keeps each scanned stroke legible as its own brushstroke (and gives
# the per-stroke impasto the relief/normal reads from).
CHANNELS = [
    # name      count  length        width       value      bristles
    ("coarse", 30, (260, 480), (40, 78), (26, 54), (10, 16)),
    ("medium", 100, (110, 230), (18, 38), (26, 54), (6, 11)),
    ("fine", 220, (56, 130), (9, 19), (26, 54), (4, 7)),
]

ASSET_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "public", "assets", "textures", "brush_strokes.png",
)
STAMPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brush_stamps")

# Cache soft radial dab kernels by rounded radius: (kernel_flat, oy_flat, ox_flat).
_KERNEL_CACHE: dict[float, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}


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


def _disc_kernel(radius: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A soft (smoothstep falloff) radial dab of the given radius, cached and
    returned as flat (values, y-offsets, x-offsets) for fast wrapped scatter-add."""
    key = round(radius, 1)
    cached = _KERNEL_CACHE.get(key)
    if cached is not None:
        return cached
    r = int(math.ceil(radius)) + 1
    ys, xs = np.mgrid[-r : r + 1, -r : r + 1]
    dist = np.sqrt((xs * xs + ys * ys).astype(np.float32))
    t = np.clip(1.0 - dist / max(radius, 1e-3), 0.0, 1.0)
    k = (t * t * (3.0 - 2.0 * t)).astype(np.float32).ravel()
    cached = (k, ys.ravel(), xs.ravel())
    _KERNEL_CACHE[key] = cached
    return cached


def _line_centers(
    cx: float, cy: float, ang: float, length: float, bend: float, offset: float, n: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Sample `n` points along a gently arced, tapered spine offset sideways by
    `offset`. Returns (xs, ys, taper-envelope, t) as arrays."""
    ca, sa = math.cos(ang), math.sin(ang)
    px, py = -sa, ca  # perpendicular (across-width) axis
    ts = np.linspace(0.0, 1.0, n)
    env = np.sin(np.pi * ts)  # taper: 0 at the ends, 1 in the loaded middle
    arc = bend * np.sin(np.pi * ts)
    along = (ts - 0.5) * length
    xs = cx + along * ca + (offset + arc) * px
    ys = cy + along * sa + (offset + arc) * py
    return xs, ys, env, ts


def _stamp_centers(
    acc: np.ndarray, xs: np.ndarray, ys: np.ndarray, radius: float, vals: np.ndarray
) -> None:
    """Stamp a soft dab of `radius` at each (xs[i], ys[i]) with value vals[i],
    vectorised into ONE wrapped scatter-add. Dense centres (spacing < radius) =>
    a CONTINUOUS stroke, not a dotted line — this is the fix for the dots."""
    k, oy, ox = _disc_kernel(radius)
    iy = (np.round(ys).astype(np.int64)[:, None] + oy[None, :]) % SIZE
    ix = (np.round(xs).astype(np.int64)[:, None] + ox[None, :]) % SIZE
    contrib = vals.astype(np.float32)[:, None] * k[None, :]
    np.add.at(acc, (iy.ravel(), ix.ravel()), contrib.ravel())


def _draw_stroke(
    acc: np.ndarray,
    cx: float,
    cy: float,
    ang: float,
    length: float,
    width: float,
    base: float,
    n_bristles: int,
    rng: random.Random,
) -> None:
    """One bristle-brush mark as CONTINUOUS lines: a loaded tapered body plus thin
    bristle streaks running along the (gently arced) spine. Dry-brush is a smooth
    along-stroke intensity ripple + a trailing fade — NEVER per-dab dropout, so it
    reads as strokes, not dots. `base` is the signed height delta (ridge +/trough −)."""
    bend = rng.uniform(-0.16, 0.16) * length  # gentle arc so it isn't dead-straight

    # Body: one wide tapered line down the centre. Centre spacing < radius so the
    # dabs fuse into a smooth filled mass (the loaded-paint core).
    body_r = max(1.0, width * 0.30)
    nb = max(10, int(length / max(body_r * 0.7, 0.6)))
    bx, by, benv, _ = _line_centers(cx, cy, ang, length, bend, 0.0, nb)
    _stamp_centers(acc, bx, by, body_r, base * (0.40 + 0.45 * benv))

    # Bristles: continuous thin streaks, value-jittered. The dry-brush look comes
    # from a smooth ripple (waxes/wanes along the hair) times a trailing fade,
    # gated to a [t0,t1] window — all continuous, so no dots.
    rad_b = max(1.1, width * 0.10)
    n = max(12, int(length / max(rad_b * 0.7, 0.6)))
    for _ in range(n_bristles):
        off = rng.uniform(-0.5, 0.5) * width
        bval = base * rng.uniform(0.55, 1.15)
        t0, t1 = rng.uniform(0.0, 0.12), rng.uniform(0.86, 1.0)
        xs, ys, env, ts = _line_centers(cx, cy, ang, length, bend, off, n)
        ripple = 0.55 + 0.45 * np.sin(ts * rng.uniform(5.0, 9.0) + rng.uniform(0.0, 6.28))
        dry = np.clip(1.0 - 0.65 * ts, 0.30, 1.0)  # fade toward the trailing end
        window = ((ts >= t0) & (ts <= t1)).astype(np.float32)
        vals = bval * (0.35 + 0.65 * env) * ripple * dry * window
        _stamp_centers(acc, xs, ys, rad_b, vals)


def _composite_stamp(
    acc: np.ndarray,
    stamp: Image.Image,
    cx: float,
    cy: float,
    ang: float,
    length: float,
    width: float,
    base: float,
    rng: random.Random,
) -> None:
    """Composite a real stroke-alpha stamp (128 = transparent): resize to the
    stroke dims, rotate to the flow angle, scatter its signed delta with wrap."""
    w, h = max(2, int(length)), max(2, int(width))
    s = stamp.resize((w, h), Image.BILINEAR).rotate(
        math.degrees(ang), expand=True, resample=Image.BICUBIC, fillcolor=128
    )
    arr = (np.asarray(s, dtype=np.float32) - 128.0) / 128.0  # signed, 0 = transparent
    hh, ww = arr.shape
    ys, xs = np.mgrid[0:hh, 0:ww]
    iy = (int(round(cy)) + ys.ravel() - hh // 2) % SIZE
    ix = (int(round(cx)) + xs.ravel() - ww // 2) % SIZE
    np.add.at(acc, (iy, ix), (arr * base).ravel())


def _build_channel(
    name: str,
    count: int,
    length: tuple[float, float],
    width: tuple[float, float],
    value: tuple[float, float],
    bristles: tuple[int, int],
    seed: int,
    stamps: list[Image.Image] | None,
) -> np.ndarray:
    """Scatter `count` flow-aligned strokes, then recentre to 0 and normalise to
    TARGET_STD so the channel is a balanced, comparable height field."""
    rng = random.Random(seed)
    acc = np.zeros((SIZE, SIZE), dtype=np.float32)
    for _ in range(count):
        cx, cy = rng.uniform(0, SIZE), rng.uniform(0, SIZE)
        ang = _flow_angle(cx, cy) + rng.uniform(-0.22, 0.22)
        ln = rng.uniform(*length)
        wd = rng.uniform(*width)
        base = rng.choice((-1.0, 1.0)) * rng.uniform(*value)
        if stamps:
            _composite_stamp(acc, rng.choice(stamps), cx, cy, ang, ln, wd, base, rng)
        else:
            _draw_stroke(acc, cx, cy, ang, ln, wd, base, rng.randint(*bristles), rng)
    acc -= float(acc.mean())  # mean 0 -> 128 stays the no-op midpoint
    std = float(acc.std())
    if std > 1e-4:
        acc *= TARGET_STD / std
    return acc


def _load_stamps() -> list[Image.Image] | None:
    """Optional real stroke-alpha library — grayscale PNGs in brush_stamps/."""
    paths = sorted(glob.glob(os.path.join(STAMPS_DIR, "*.png")))
    if not paths:
        return None
    return [Image.open(p).convert("L") for p in paths]


def build() -> None:
    stamps = _load_stamps()
    print(
        f"[brush-texture] strokes: {'real stamps ×' + str(len(stamps)) if stamps else 'procedural bristles'}"
    )
    chans = []
    for i, (name, count, length, width, value, bristles) in enumerate(CHANNELS):
        ch = _build_channel(name, count, length, width, value, bristles, SEED + i, stamps)
        chans.append(np.clip(128.0 + ch, 0, 255).astype(np.uint8))
        print(f"[brush-texture]   {'RGB'[i]} = {name:>6}: {count} strokes")
    out = Image.merge("RGB", [Image.fromarray(c, "L") for c in chans])
    os.makedirs(os.path.dirname(ASSET_PATH), exist_ok=True)
    out.save(ASSET_PATH, "PNG", optimize=True)
    print(f"[brush-texture] wrote {ASSET_PATH} ({os.path.getsize(ASSET_PATH)} bytes)")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:  # noqa: BLE001
        print(f"[brush-texture] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
