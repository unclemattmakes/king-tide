"""Build ``public/assets/textures/foam_streaks.png`` — the flow-aligned foam
brushstroke sheet the water shader combs down the wave faces (see
``src/engine/render/water.ts`` ``getFoamStreakTexture`` + the foam-streak block,
and ``docs/water-foam-look-plan.md``).

Runs **inside Blender** (it reads the source strokes from ``.exr`` maps, which
plain Python can't decode):

    pnpm gen:foam-streaks            # → node tools/blender/seed.mjs build_foam_streaks.py
    # or: blender --background --python tools/blender/build_foam_streaks.py

## What it does

Scatters tapered brush strokes onto a seamless (toroidal) 1024² tile, all
running along the texture's **+U axis** with clean gaps between, value-flipped /
length-varied / jittered. The water shader samples it with U mapped to the wave
surface-gradient (down-face) direction, so the strokes trace the wave shape.
R channel = stroke alpha (0 = clean water, 1 = stroke core); saved Non-Color.

## Stroke source + licence

Harvests the **Blender *Brushstroke Tools* addon's** bundled oil-stroke maps
(``streaky_dashes`` + ``feathery``) by Simon Thommes / Blender Studio (Project
Gold). The addon *code* is GPL-3.0, but the brush-style *assets* are **CC BY
4.0** — so a sheet baked from them ships fine **with attribution**. That credit
lives on the in-game credits screen (``menu-flow.ts`` → BRUSH TEXTURES), shared
with the prop brush sheet, which draws from the same source. Keep the credit in
sync if the source changes.

The built PNG is gitignored + R2-served like ``brush_strokes.png``; a fresh
clone rebuilds it with this script (Blender + the addon installed), or it falls
back to no streaks (the shader's 1×1-black fallback) if absent.
"""

import os
import sys

import bpy
import numpy as np

N = 1024  # output tile resolution
SEED = 7
# Stroke-source maps inside the Brushstroke Tools addon (resolved at runtime).
# (filename-stem, weight) — higher weight = sampled more often.
STROKE_SOURCES = [("oil_paint-streaky_dashes", 2), ("oil_paint-feathery", 1)]


def _addon_maps_dir():
    import addon_utils

    for m in addon_utils.modules():
        if m.__name__.endswith("brushstroke_tools"):
            return os.path.join(os.path.dirname(m.__file__), "assets", "styles", "maps")
    raise SystemExit(
        "Brushstroke Tools addon not found — install/enable it, or repoint "
        "STROKE_SOURCES at ours-to-ship strokes (see module docstring)."
    )


def _repo_root():
    # tools/blender/build_foam_streaks.py → repo root
    return os.environ.get("HOVERBIKE_REPO_ROOT") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )


def _load_stroke_field(maps_dir, stem):
    """Load an .exr stroke library as a top-down array where bright = stroke."""
    path = os.path.join(maps_dir, stem + ".exr")
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[:, :, 0][::-1]  # R, flipped to top-down
    bg = float(np.median(a))
    return np.clip((bg - a) / max(bg, 1e-3), 0.0, 1.0)  # darker-than-bg → bright


def main():
    maps_dir = _addon_maps_dir()
    rng = np.random.default_rng(SEED)
    fields = []
    for stem, weight in STROKE_SOURCES:
        f = _load_stroke_field(maps_dir, stem)
        fields += [f] * weight

    sheet = np.zeros((N, N), np.float32)

    def grab_strip(src, len_frac):
        h, w = src.shape
        y0 = int(rng.integers(0, h - h // 22))
        band = src[y0 : y0 + h // 22, int(w * 0.34) :]  # one row, long-stroke region
        ln = band.shape[1]
        ww = int(ln * len_frac)
        x0 = int(rng.integers(0, max(1, ln - ww)))
        return band[:, x0 : x0 + ww]

    for i in range(70):
        src = fields[int(rng.integers(0, len(fields)))]
        strip = grab_strip(src, 0.35 + rng.random() * 0.6)
        tw = int(N * (0.18 + rng.random() * 0.34))  # long
        th = max(3, int(N * (0.018 + rng.random() * 0.03)))  # thin
        ys = np.clip(np.linspace(0, strip.shape[0] - 1, th).astype(int), 0, strip.shape[0] - 1)
        xs = np.clip(np.linspace(0, strip.shape[1] - 1, tw).astype(int), 0, strip.shape[1] - 1)
        resized = strip[ys][:, xs]
        if rng.random() < 0.5:
            resized = resized[:, ::-1]
        oy = int(rng.integers(0, N))
        ox = int(rng.integers(0, N))
        for dy in range(th):
            Y = (oy + dy) % N
            Xs = (ox + np.arange(tw)) % N
            sheet[Y, Xs] = np.maximum(sheet[Y, Xs], resized[dy])

    sheet = np.clip(sheet * 1.15, 0.0, 1.0)

    out_img = bpy.data.images.new("foam_streaks", N, N, alpha=False)
    out_img.colorspace_settings.name = "Non-Color"
    rgba = np.zeros((N, N, 4), np.float32)
    rgba[:, :, 0] = rgba[:, :, 1] = rgba[:, :, 2] = sheet
    rgba[:, :, 3] = 1.0
    out_img.pixels.foreach_set(rgba[::-1].ravel())  # back to bottom-up
    out_path = os.path.join(_repo_root(), "public", "assets", "textures", "foam_streaks.png")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out_img.filepath_raw = out_path
    out_img.file_format = "PNG"
    out_img.save()
    print(f"[build_foam_streaks] wrote {out_path} (coverage {sheet.mean():.3f})")


if __name__ == "__main__":
    main()
    # Blender's --python leaves the process running headlessly; exit cleanly.
    if bpy.app.background:
        sys.exit(0)
