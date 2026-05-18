# Tauri app icons

Placeholder directory — real art lands with v1.

When the v1 art is ready, generate the full icon set from a 1024² master:

```sh
cd src-tauri
cargo tauri icon path/to/master.png
```

That writes:

- `32x32.png` — Linux taskbar / GTK
- `128x128.png`, `128x128@2x.png` — Linux high-DPI
- `icon.icns` — macOS app bundle
- `icon.ico` — Windows executable

The Steam Library shopfront images (capsule, header, hero) are separate
from these — they're uploaded to the Steam Partner backend via the
Steamworks shopfront editor.
