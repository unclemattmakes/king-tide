# Brush stamps — real oil-stroke library for the brush sheet

`build_brush_texture.py` (`pnpm gen:brush-texture`) composites the grayscale PNG
stamps in this folder into the shared, seamless `brush_strokes.png` sheet. With
none present it falls back to procedural bristle strokes (so a fresh clone always
builds), but **the shipped sheet uses the real strokes harvested here.**

The `*.png` stamps are **gitignored** (derived build inputs, like other compiled
assets — see the repo `.gitignore`). Regenerate them locally:

```
pnpm gen:brush-stamps      # harvest_brush_stamps.py — needs the add-on installed
pnpm gen:brush-texture     # composite them into brush_strokes.png
pnpm assets:push           # ship the sheet to R2
```

## Source + ATTRIBUTION (required)

The stamps are sliced from the **Blender Studio "Brushstroke Tools"** add-on's
scanned oil-paint brush-style maps (`assets/styles/maps/oil_paint-*.exr`), via
`tools/blender/harvest_brush_stamps.py`. Install the extension from
`extensions.blender.org/add-ons/brushstroke-tools/` first.

Shipping a sheet derived from these assets **requires attribution**: the brush
assets are **CC BY 4.0** (Blender Studio / Project Gold, © Blender Foundation),
so a derived sheet ships commercially with credit — carried on the in-game
**credits page** (`buildCredits()` in `src/engine/menus/menu-flow.ts`). Keep that
credit in place if you re-roll the stamps. (Only the flat stroke *textures* are
used; the add-on's stroke *geometry* is render-only and never enters the game.)

## Stamp format

- Grayscale PNG, **128 = neutral** (no height change), brighter = raised stroke
  ridge — the signed-height convention the sheet uses.
- One isolated stroke per file, roughly pointing **+X** (the generator rotates
  each placement to the flow field). Any size; it's resized per scattered stroke.

To hand-author alternatives instead of harvesting, paint single strokes on a
mid-grey (128) canvas and drop them here, then re-run `gen:brush-texture`.
