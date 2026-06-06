"""Harvest real oil-paint stroke stamps from the Blender Studio **Brushstroke
Tools** add-on, for use by ``build_brush_texture.py`` (the brush-sheet generator).

The add-on ships scanned oil-paint *brush-style* maps (sheets of many individual
strokes) under ``assets/styles/maps/*.exr``. This slices the cleaner sheets into
individual single-stroke grayscale PNGs in ``tools/blender/brush_stamps/`` in the
neutral-bg / ridge convention the generator expects (128 = no paint, brighter =
stroke). ``build_brush_texture.py`` then composites them into the seamless,
prop-size-blended ``brush_strokes.png`` we ship.

These stamps are DERIVED from the add-on's assets and are **gitignored** — re-run
this to regenerate them locally (you need the add-on installed). Attribution is
required by the asset licence; see ``brush_stamps/README.md`` and the in-game
credits.

Run (needs the Brushstroke Tools extension installed in your Blender):
    pnpm gen:brush-stamps
    # or
    blender --background --python tools/blender/harvest_brush_stamps.py
"""
from __future__ import annotations

import os
import sys

import addon_utils
import bpy
import numpy as np

# Cleaner stroke sheets only — `grunge` is broken speckle, not strokes.
FILES = ["oil_paint-dry_loaded.exr", "oil_paint-dry_scrumble.exr", "oil_paint-fat_loaded.exr",
         "oil_paint-feathery.exr", "oil_paint-streaky_dashes.exr"]
PER_FILE = 8       # keep the N biggest/cleanest strokes per sheet
MAXDIM = 256       # downscale cap per stamp (the generator resizes anyway)
THRESH = 0.65      # value below this = paint (dark on a white sheet)

STAMPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brush_stamps")


def find_maps_dir():
    """Locate the installed Brushstroke Tools extension's brush-style maps dir."""
    for m in addon_utils.modules():
        if getattr(m, "__name__", "").endswith("brushstroke_tools"):
            d = os.path.join(os.path.dirname(m.__file__), "assets", "styles", "maps")
            if os.path.isdir(d):
                return d
    return None


def segments(mask, min_gap, min_len):
    """Runs of True separated by gaps > min_gap, each at least min_len long."""
    idx = np.where(mask)[0]
    if len(idx) == 0:
        return []
    segs = []; s = idx[0]; p = idx[0]
    for i in idx[1:]:
        if i - p > min_gap:
            if p - s + 1 >= min_len:
                segs.append((s, p + 1))
            s = i
        p = i
    if p - s + 1 >= min_len:
        segs.append((s, p + 1))
    return segs


def save_stamp(gray, path):
    """gray: crop 0..1, dark=paint. Write a grayscale PNG: bg->128, paint->255."""
    cov = np.clip(1.0 - np.clip(gray, 0, 1), 0, 1)
    h, w = cov.shape
    f = max(1, max(h, w) // MAXDIM)
    if f > 1:
        h2, w2 = (h // f) * f, (w // f) * f
        cov = cov[:h2, :w2].reshape(h2 // f, f, w2 // f, f).mean(axis=(1, 3))
    H, W = cov.shape
    stamp = np.clip(0.5 + cov * 0.5, 0, 1)  # bg->0.5 (128), paint->1.0 (ridge)
    rgba = np.empty((H, W, 4), np.float32)
    rgba[:, :, 0] = rgba[:, :, 1] = rgba[:, :, 2] = stamp
    rgba[:, :, 3] = 1.0
    ni = bpy.data.images.new("stmp", W, H, alpha=True, float_buffer=False)
    ni.colorspace_settings.name = 'Non-Color'
    ni.pixels.foreach_set(rgba[::-1].reshape(-1))  # store bottom-up
    ni.file_format = 'PNG'
    ni.filepath_raw = path
    ni.save()
    bpy.data.images.remove(ni)


def harvest():
    maps = find_maps_dir()
    if not maps:
        raise SystemExit(
            "Brushstroke Tools extension not found — install it in Blender first "
            "(Preferences > Get Extensions > 'Brushstroke Tools'), then re-run."
        )
    os.makedirs(STAMPS_DIR, exist_ok=True)
    for f in os.listdir(STAMPS_DIR):
        if f.lower().endswith('.png'):
            os.remove(os.path.join(STAMPS_DIR, f))

    total = 0
    for fn in FILES:
        src = os.path.join(maps, fn)
        if not os.path.exists(src):
            print("[harvest] skip (missing): %s" % fn)
            continue
        img = bpy.data.images.load(src, check_existing=True)
        w, h, ch = img.size[0], img.size[1], img.channels
        a = np.empty(w * h * ch, dtype=np.float32); img.pixels.foreach_get(a)
        g = a.reshape(h, w, ch)[::-1, :, 0]  # top-down grayscale
        paint = (g < THRESH).astype(np.float32)
        bands = segments(paint.sum(axis=1) > w * 0.004, int(h * 0.012), int(h * 0.02))
        crops = []
        for (r0, r1) in bands:
            cells = segments(paint[r0:r1].sum(axis=0) > (r1 - r0) * 0.04,
                             int(w * 0.008), int(w * 0.02))
            for (c0, c1) in cells:
                py, px = int((r1 - r0) * 0.08), int((c1 - c0) * 0.08)
                crop = g[max(0, r0 - py):min(h, r1 + py), max(0, c0 - px):min(w, c1 + px)]
                cov = (crop < THRESH).mean()
                if crop.shape[0] > 24 and crop.shape[1] > 24 and 0.04 < cov < 0.85:
                    crops.append((crop.shape[0] * crop.shape[1], crop))
        crops.sort(key=lambda t: -t[0])
        stem = fn.replace('oil_paint-', '').replace('.exr', '')
        for k, (_, crop) in enumerate(crops[:PER_FILE]):
            save_stamp(crop, os.path.join(STAMPS_DIR, "%s_%02d.png" % (stem, k)))
            total += 1
        bpy.data.images.remove(img)
        print("[harvest] %s -> %d stamps" % (fn, min(len(crops), PER_FILE)))
    print("[harvest] wrote %d stamps to %s" % (total, STAMPS_DIR))


if __name__ == "__main__":
    try:
        harvest()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print("[harvest] FAILED: %r" % e, file=sys.stderr)
        sys.exit(1)
