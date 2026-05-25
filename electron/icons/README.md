# App icons (Electron builds)

Placeholder directory — real art lands with v1. electron-builder reads
`icon.png` (Linux) and `icon.ico` (Windows) from here; the PNG set is
the Linux size ladder.

Regenerate the solid-teal placeholders any time:

```sh
pnpm gen:icons
```

Contents:

- `32x32.png` — Linux taskbar
- `128x128.png`, `128x128@2x.png` — Linux high-DPI (256² master also feeds the .ico)
- `icon.png` — 512² master (Linux)
- `icon.ico` — Windows executable + NSIS installer (PNG-in-ICO)

When real art is ready, replace these with exports from the 1024² master
(any icon generator works; no platform toolchain required).

The Steam Library shopfront images (capsule, header, hero) are separate
from these — they're uploaded to the Steam Partner backend via the
Steamworks shopfront editor.
