#!/bin/bash
# Steam / Linux launch wrapper for the Electron build.
#
# Point the Steamworks *Linux* launch executable at THIS script, not at
# `hoverbike` directly. It does two things the Steam Linux Runtime (sniper)
# forces on us — see docs/desktop-builds.md "Steam Deck / Linux runtime
# gotchas" for the full story:
#
#   1. Strip the Steam overlay (gameoverlayrenderer.so) from LD_PRELOAD.
#      Its injector segfaults this Electron build during library init — in
#      BOTH Desktop and Gaming Mode — and the overlay barely functions with
#      Electron on Linux anyway, so we drop it and the app launches.
#
#   2. Prepend bundled libraries the runtime omits — notably libcups.so.2,
#      which Electron's Chromium dlopen()s but sniper doesn't ship.
#
# Everything else Steam set up (the rest of LD_PRELOAD, the runtime's
# LD_LIBRARY_PATH) is preserved.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

# 1. Bundled libs the Steam Linux Runtime is missing (tools/build-deck.mjs
#    drops them into extra-lib/).
export LD_LIBRARY_PATH="$HERE/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# 2. Remove any gameoverlayrenderer.so entry from LD_PRELOAD. LD_PRELOAD may
#    be colon- or space-separated; rebuild it colon-separated without the
#    overlay, keeping every other entry intact.
if [ -n "${LD_PRELOAD:-}" ]; then
  cleaned=""
  old_ifs="$IFS"
  IFS=': '
  for entry in $LD_PRELOAD; do
    case "$entry" in
      *gameoverlayrenderer.so) : ;;  # drop the overlay
      "") : ;;
      *) cleaned="${cleaned:+$cleaned:}$entry" ;;
    esac
  done
  IFS="$old_ifs"
  export LD_PRELOAD="$cleaned"
fi

exec "$HERE/hoverbike" --no-sandbox "$@"
