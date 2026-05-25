#!/usr/bin/env bash
#
# Strip bundled libwayland-* libraries from a Tauri-built AppImage.
#
# Tauri's AppImage bundler copies every ldd dependency of GTK/WebKit into
# usr/lib, including libwayland-client.so.0. eglGetPlatformDisplay(EGL_PLATFORM_
# WAYLAND) requires the wl_display proxy to come from the *same* libwayland-client
# instance the host's Mesa EGL driver uses. When the bundled (build-host) copy
# shadows the host's on the loader path, the proxy is foreign and EGL rejects it
# with EGL_BAD_PARAMETER — WebKitGTK then aborts before the window opens. On the
# Steam Deck this is fatal. The AppImage excludelist names these libs as "never
# bundle"; linuxdeploy honors it, Tauri does not, so we strip them post-build.
#
# Repacks the payload onto the AppImage's *own* runtime (carved off the front of
# the file) so we never fabricate an incompatible runtime, using gzip squashfs
# compression which every squashfuse build can mount.
#
# Usage: tools/fix-appimage-wayland.sh <path-to .AppImage>
set -euo pipefail

APPIMAGE="${1:?usage: fix-appimage-wayland.sh <path-to .AppImage>}"
[ -f "$APPIMAGE" ] || { echo "fix-appimage-wayland: no such file: $APPIMAGE" >&2; exit 1; }

if ! command -v mksquashfs >/dev/null 2>&1; then
  echo "fix-appimage-wayland: mksquashfs not found — install squashfs-tools" >&2
  exit 1
fi

APPIMAGE="$(readlink -f "$APPIMAGE")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. Carve out the AppImage's own runtime (everything before the squashfs image).
offset="$("$APPIMAGE" --appimage-offset)"
head -c "$offset" "$APPIMAGE" > "$work/runtime"

# 2. Extract the payload (--appimage-extract needs no FUSE) and drop the libs.
#    Search a couple of levels down so we catch both the flat usr/lib layout and
#    the multiarch usr/lib/x86_64-linux-gnu one across Tauri bundler versions.
( cd "$work" && "$APPIMAGE" --appimage-extract >/dev/null )
removed=0
while IFS= read -r f; do
  rm -f "$f"
  echo "fix-appimage-wayland: removed ${f#"$work"/squashfs-root/}"
  removed=1
done < <(find "$work/squashfs-root/usr/lib" -maxdepth 2 -name 'libwayland-*.so*' 2>/dev/null)
if [ "$removed" -eq 0 ]; then
  echo "fix-appimage-wayland: no bundled libwayland-* found — leaving $APPIMAGE untouched"
  exit 0
fi

# 3. Repack the payload and glue it back onto the original runtime.
mksquashfs "$work/squashfs-root" "$work/payload.squashfs" \
  -root-owned -noappend -no-progress -comp gzip >/dev/null
cat "$work/runtime" "$work/payload.squashfs" > "$work/fixed.AppImage"
chmod +x "$work/fixed.AppImage"
mv "$work/fixed.AppImage" "$APPIMAGE"
echo "fix-appimage-wayland: rewrote $APPIMAGE ($(du -h "$APPIMAGE" | cut -f1))"
