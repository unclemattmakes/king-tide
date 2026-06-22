"""Headless verify: the EXPORTED gate 0 / finish line follows
``hoverbike_start_t`` in spline-driven gate mode — i.e. moving the start
slider relocates the in-game lap line, not just the Blender preview.

Builds the track JSON twice (start_t = 0.0 and 0.4) via the real
``derive_track_json`` and asserts gate 0 moved with the start and stays
coincident with the start spawn. Materialized (cp_NN) tracks are reported
but skipped — their gate 0 is the baked cp_00 position by design.

Run:
    "$BLENDER_EXE" --background --factory-startup \
        "C:/project-content/hoverbike/tracks-src/cape-town-drift.blend" \
        --python tools/blender/_smoke_export_startgate.py -- \
        --addon-root "<this worktree>/tools/blender"

``--background`` is a separate process and the script never saves, so a
live session is untouched.
"""
import math
import os
import sys


def _argv_after():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def _arg(a, flag, default=None):
    return a[a.index(flag) + 1] if flag in a else default


def _fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def main():
    import bpy

    a = _argv_after()
    root = _arg(a, "--addon-root")
    if not root or not os.path.isdir(root):
        _fail(f"--addon-root missing/invalid: {root!r}")
    if root not in sys.path:
        sys.path.insert(0, root)

    import hoverbike_addon

    try:
        hoverbike_addon.register()
    except Exception as e:  # noqa: BLE001 — tolerate already-registered
        print(f"[smoke] register() note: {e}")

    from hoverbike_addon._legacy import bake_ai_splines, derive_track_json

    sp = bpy.data.objects.get("ai_spline_main")
    if sp is None:
        _fail("no ai_spline_main in scene (wrong blend path?)")
    scn = bpy.context.scene

    cp_empties = [
        o for o in bpy.data.objects if o.name.startswith("cp_") and o.name[3:].isdigit()
    ]
    if cp_empties:
        print(
            f"[smoke] SKIP: track is MATERIALIZED ({len(cp_empties)} cp_NN empties); "
            "gate 0 is the baked cp_00 position by design, not start_t-driven."
        )
        sys.exit(0)
    print("[smoke] gate mode: SPLINE-DRIVEN (no cp_NN)")

    def cp0_at(t):
        scn.hoverbike_start_bound_to_spline = True
        scn.hoverbike_start_t = t
        # Mirror the live slider: setting start_t schedules a re-snap of
        # start_00/01 to that t (debounce timer → snap_starts_to_spline).
        # The timer doesn't tick in --background, so call the op directly;
        # the export reads start_00's actual position, and the gate-0
        # rotation re-pins to it, so the starts MUST be at t for the
        # finish line to land on the start.
        bpy.ops.hoverbike.snap_starts_to_spline()
        bake_ai_splines()
        j = derive_track_json("cape-town-drift", "https://x/cape-town-drift.glb")
        cps = j["checkpoints"]
        if not cps:
            _fail("derive_track_json produced 0 checkpoints")
        return cps[0]["position"], j["start"]["position"], len(cps)

    c0_a, _st_a, n = cp0_at(0.0)
    c0_b, st_b, _n2 = cp0_at(0.4)

    moved = math.hypot(c0_a["x"] - c0_b["x"], c0_a["z"] - c0_b["z"])
    print(
        f"[smoke] gate0 @ t=0.0 ({c0_a['x']:.1f},{c0_a['z']:.1f}) -> "
        f"t=0.4 ({c0_b['x']:.1f},{c0_b['z']:.1f}) | moved {moved:.1f} m over {n} gates"
    )
    if moved < 20.0:
        _fail(f"gate 0 barely moved ({moved:.1f} m) — export does NOT follow start_t")

    d0 = math.hypot(c0_b["x"] - st_b["x"], c0_b["z"] - st_b["z"])
    print(f"[smoke] at t=0.4: gate0 sits {d0:.1f} m from the start spawn")
    if d0 > 20.0:
        _fail(f"gate 0 is {d0:.1f} m from the start at t=0.4 — finish line not at the start")

    print("PASS: exported gate 0 / finish line follows hoverbike_start_t")
    sys.exit(0)


if __name__ == "__main__":
    main()
