"""Headless smoke: the "Start at t" control auto-binds and moves the
start grid to the chosen parameter.

Verifies the always-on start-gate slider wiring without a GUI, so it
can't disturb a live editing session. Run via:

    "$BLENDER_EXE" --background --factory-startup \
        "C:/project-content/hoverbike/tracks-src/cape-town-drift.blend" \
        --python tools/blender/_smoke_start_snap.py -- \
        --addon-root "<this worktree>/tools/blender" --t 0.42

``--background`` opens a SEPARATE process from any GUI session and the
script never saves, so the .blend on disk and any open window are
untouched. ``--addon-root`` must point at the worktree being tested so
the smoke exercises the EDITED addon, not the symlinked install.

Asserts:
  1. Setting ``scene.hoverbike_start_t`` while UNBOUND flips
     ``hoverbike_start_bound_to_spline`` True synchronously (auto-bind,
     from _on_start_t_changed).
  2. ``snap_starts_to_spline`` then lands start_00 near the t-anchor
     (within back-off + spacing tolerance) and stamps start_t == t.

The live drag path runs on a 0.2 s debounce timer that doesn't tick in
``--background``; we call the operator directly (the same op the timer
dispatches) to assert the movement.
"""
import math
import os
import sys


def _argv_after_ddash() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def _get_arg(args: list[str], flag: str, default=None):
    return args[args.index(flag) + 1] if flag in args else default


def _fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    import bpy

    args = _argv_after_ddash()
    addon_root = _get_arg(args, "--addon-root")
    t = float(_get_arg(args, "--t", "0.42"))
    if not addon_root or not os.path.isdir(addon_root):
        _fail(f"--addon-root missing/invalid: {addon_root!r}")
    if addon_root not in sys.path:
        sys.path.insert(0, addon_root)

    import kingtide_addon

    # Register UNCONDITIONALLY — the hasattr() guard the export smokes use
    # skips Scene-prop registration under --factory-startup, which then
    # AttributeErrors on hoverbike_start_bound_to_spline. Tolerate an
    # already-registered addon (running without --factory-startup).
    try:
        kingtide_addon.register()
    except Exception as e:  # noqa: BLE001
        print(f"[smoke] register() note (likely already enabled): {e}")

    sp = bpy.data.objects.get("ai_spline_main")
    s0 = bpy.data.objects.get("start_00")
    if sp is None or s0 is None:
        _fail("scene missing ai_spline_main or start_00 (wrong blend path?)")

    scene = bpy.context.scene

    # 1) AUTO-BIND — start unbound, set the slider, assert the update
    #    callback anchored the start synchronously.
    scene.hoverbike_start_bound_to_spline = False
    scene.hoverbike_start_t = t  # fires _on_start_t_changed
    if not bool(scene.hoverbike_start_bound_to_spline):
        _fail("setting hoverbike_start_t did not auto-bind the start")
    print(f"[smoke] auto-bind OK (bound={bool(scene.hoverbike_start_bound_to_spline)})")

    # 2) SNAP — the op the debounce timer would call. Assert the grid
    #    landed on the t-anchor (offset behind + beside it, not exact).
    from kingtide_addon.spline import sample_curve_at_t

    target = sample_curve_at_t(sp, t)
    if target is None:
        _fail(f"sample_curve_at_t returned None at t={t}")
    res = bpy.ops.kingtide.snap_starts_to_spline()
    if res != {"FINISHED"}:
        _fail(f"snap_starts_to_spline returned {res}")
    bpy.context.view_layer.update()

    stamped = float(s0.get("start_t", -1.0))
    if abs(stamped - t) > 1e-4:
        _fail(f"start_00.start_t={stamped} != requested {t}")

    loc = s0.matrix_world.translation
    dist_xy = math.hypot(loc.x - target["x"], loc.y - target["y"])
    back_off = float(getattr(scene, "hoverbike_start_backoff_m", 8.0))
    spacing = float(getattr(scene, "hoverbike_start_grid_spacing", 4.0))
    tol = back_off + spacing + 3.0  # starts sit behind + beside the anchor
    if dist_xy > tol:
        _fail(f"start_00 {dist_xy:.1f} m from t-anchor (tolerance {tol:.1f} m)")

    # 3) COUPLING — a t change must queue gates + racer (the START/FINISH
    #    line + grid preview), not just starts. This is the decoupling
    #    bug fix: previously only "starts" was scheduled, so the finish
    #    line stayed frozen on a drag. Inspect the debounce queue directly
    #    (the timer doesn't tick in --background).
    from kingtide_addon import handlers as _h

    _h._pending_rebuilds.clear()
    scene.hoverbike_start_t = 0.6  # different value → re-fires the callback
    queued = set(_h._pending_rebuilds)
    missing = {"starts", "gates", "racer"} - queued
    if missing:
        _fail(f"t-change did not queue {sorted(missing)} (queued: {sorted(queued)})")
    print(f"[smoke] coupling OK — t-change queued {sorted(queued)}")

    print(
        f"PASS: start_00 @ ({loc.x:.1f}, {loc.y:.1f}, {loc.z:.2f}); "
        f"t-anchor @ ({target['x']:.1f}, {target['y']:.1f}); "
        f"dist_xy={dist_xy:.1f} m; stamped_t={stamped}"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
