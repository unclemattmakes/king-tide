# Brush stamps — optional real stroke-alpha library

`build_brush_texture.py` (`pnpm gen:brush-texture`) draws **procedural bristle
strokes** by default. Drop grayscale PNGs in this folder and they are composited
**instead** — the hook for real painted media in the shared `brush_strokes.png`
sheet.

## Format

- Grayscale PNG, **128 = transparent** (no height change). Brighter = raised
  bristle ridge, darker = trough — same signed-height convention as the sheet.
- One isolated stroke per file, ideally pointing roughly **+X** (the generator
  rotates each placement to the flow field). Any size; it's resized per stroke.
- A handful (4–10) of varied strokes is plenty — they're scattered, jittered,
  value-flipped and rotated, so variety compounds.

## Where to get them

- **Hand-paint** them (Krita/Photoshop/Blender texture paint) on a mid-grey
  canvas — fastest to control and unambiguously ours to ship.
- **Harvest** the scanned oil-stroke textures from Blender's *Brushstroke Tools*
  brush-style packs (`studio.blender.org/tools/addons/brushstroke_tools`). Note:
  confirm the brush-style texture licence before shipping a derived sheet. The
  addon's stroke *geometry* is render-only and never enters the game — we only
  ever want flat stroke alphas here. See the addon research note in memory
  (`reference_blender_brushstroke_tools`).

Re-run `pnpm gen:brush-texture` after adding/removing stamps. With none present,
the deterministic procedural default is used (so a fresh clone always builds).
