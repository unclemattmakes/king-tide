"""Headless track-lint runner — wraps the addon's lint logic for CI.

Invocation (via ``tools/blender/run-lint.mjs``)::

    blender --background tracks-src/<id>.blend --python tools/blender/lint_track.py

What it does:

  1. Enables the King Tide addon (same registration the smoke test
     uses, see ``test_addon_registration.py``).
  2. Calls the addon's existing ``_lint_track`` + ``validate_track_scene``
     against the currently-loaded scene so authoring-time and CI lint
     stay byte-identical.
  3. Layers a few CI-only checks the in-editor lint elides for the sake
     of brevity (``start_01`` presence, ``cp_NN`` contiguity, wave-zone
     extras sanity, at-least-one ``pickup_*`` as a warning).
  4. Emits a deterministic ``[lint:<trackId>] <severity>: <message>``
     line per finding to stdout. Exit code 1 if any ERROR; 0 otherwise.

The track id is derived from the .blend's basename (matches the runtime's
"basename = track id" convention from `docs/blender-pipeline-guide.md`).

Layout notes:

  * The script never mutates the scene — it's strictly inspection. Safe
    to run multiple times against the same .blend.
  * Preview gizmos (boost-pad, wave-zone, antigrav) are hidden via the
    same context manager the in-editor lint uses, so we lint against the
    *exported* state, not the authoring-time scaffolding.
  * One Blender startup per .blend. ~2 s/blend is acceptable for a CI
    run that visits ~12 tracks once per PR.
"""

from __future__ import annotations

import os
import re
import sys

import bpy
import mathutils

ADDON_MODULE = "kingtide_addon"

# Mirror the wave-zone authoring contract from
# ``kingtide_addon/wave_zone.py``. Each ``wave_zone_NN`` empty needs
# positive half-extents (the OBB has to enclose *something*) and a
# positive ``height_mult`` (zero-mult zones are a footgun — author
# probably meant to delete the zone instead).
_WAVE_ZONE_NAME_RE = re.compile(r"^wave_zone_(\d+)$")
_CP_NAME_RE = re.compile(r"^cp_(\d+)$")
_PICKUP_NAME_RE = re.compile(r"^pickup_(?:\d+|main)$")
_KIND_TRACK_AREA_EPS = 1e-3  # square metres. Anything below is degenerate.


def _track_id_from_blend() -> str:
    """Match the convention the runtime + export operator both use: the
    .blend's basename (minus extension) is the in-game id."""
    blend = bpy.data.filepath
    if not blend:
        # Headless invocation without an open .blend — fall back to a
        # stable label so the prefix still reads.
        return "<no-blend>"
    name = os.path.basename(blend)
    if name.endswith(".blend"):
        name = name[: -len(".blend")]
    return name


def _enable_addon() -> bool:
    """Same shape as ``test_addon_registration.py`` — if enable raises,
    the lint can't run; surface a clear error and bail."""
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_MODULE)
    except Exception as exc:  # noqa: BLE001 — any Exception means we can't lint.
        print(
            f"[lint] FATAL: could not enable {ADDON_MODULE}: {exc}",
            file=sys.stderr,
        )
        return False
    return True


def _mesh_world_area(obj: bpy.types.Object) -> float:
    """Sum of evaluated polygon areas in world space. Geometry Nodes /
    modifier output is included because we evaluate via the depsgraph
    before reading polygons — same surface the exporter actually emits.

    Returns 0.0 if the mesh has no polygons or evaluation fails. We
    apply the object's world-space scale to each polygon's local area
    (Blender's ``polygon.area`` is in the mesh's local frame); for
    non-uniformly-scaled meshes this is an approximation, but it's the
    right ballpark for the "positive area" lint check we actually care
    about — degenerate / zero-scale meshes."""
    if obj.type != "MESH":
        return 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    try:
        eobj = obj.evaluated_get(dg)
        me = eobj.to_mesh()
    except RuntimeError:
        return 0.0
    if me is None:
        return 0.0
    try:
        # World-scale fudge: |det(M3x3)|^(2/3) is the right factor for
        # an *isotropic* scale → area. For mixed scales this still
        # surfaces zero/degenerate meshes (which is all we need) but is
        # not a precise figure. Don't depend on the magnitude — only
        # the sign matters for the "positive area" check.
        m = obj.matrix_world.to_3x3()
        det = abs(m.determinant())
        scale_factor = det ** (2.0 / 3.0) if det > 0.0 else 0.0
        total_local = 0.0
        for poly in me.polygons:
            total_local += poly.area
        return float(total_local * scale_factor)
    finally:
        try:
            eobj.to_mesh_clear()
        except Exception:  # noqa: BLE001
            pass


def _extra_checks(track_id: str) -> tuple[list[str], list[str]]:
    """CI-only checks that complement the in-editor lint. Kept here
    rather than added to ``_lint_track`` so the in-editor lint stays
    fast/quiet for the authoring loop."""
    errors: list[str] = []
    warnings: list[str] = []

    # start_01 — the in-editor lint covers start_00 only because authors
    # iterate on a single-start scene during early layout. By CI time
    # the track must have a second start pose for AI grid spawns to
    # work.
    if bpy.data.objects.get("start_01") is None:
        errors.append("Missing `start_01` — AI grid spawn won't work.")

    # cp_NN contiguity. validate_track_scene already checks the
    # custom-prop `index` field but doesn't verify the *name* gaps.
    # An author who deletes cp_02 and forgets to rename cp_03..N
    # produces a non-contiguous lap that the runtime silently
    # mis-indexes. Treat as ERROR — at CI time we want this loud.
    cps: list[tuple[int, str]] = []
    for obj in bpy.data.objects:
        m = _CP_NAME_RE.match(obj.name)
        if m is None:
            continue
        cps.append((int(m.group(1)), obj.name))
    if cps:
        cps.sort()
        expected = list(range(len(cps)))
        actual = [n for n, _ in cps]
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            bits = []
            if missing:
                bits.append(
                    f"missing indices {missing} (lap won't close — "
                    f"rename higher cps down to fill the gap)"
                )
            if extra:
                bits.append(
                    f"unexpected indices {extra} (cp_NN must start at 0 "
                    f"and be contiguous)"
                )
            errors.append(
                "Non-contiguous cp_NN sequence: " + "; ".join(bits)
            )

    # At least one pickup_* — warning, not error. Some tracks (tutorial
    # / hand-built tests) legitimately ship without pickups.
    has_pickup = any(_PICKUP_NAME_RE.match(o.name) for o in bpy.data.objects)
    if not has_pickup:
        warnings.append(
            "No `pickup_*` empties found — track has zero pickup spawns. "
            "Add a `pickup_NN` if pickups are intended for this layout."
        )

    # kind=track meshes must have positive evaluated area. Zero-area
    # meshes happen when an author leaves a degenerate placeholder
    # tagged `kind=track` (the runtime's collider build then either
    # explodes or silently ignores it). Cheap to check; loud if hit.
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.get("kind") != "track":
            continue
        if obj.hide_get() or obj.hide_viewport:
            continue
        area = _mesh_world_area(obj)
        if area <= _KIND_TRACK_AREA_EPS:
            errors.append(
                f"`{obj.name}` is kind=track but has zero/degenerate area "
                f"({area:.4f} m²). Delete the mesh or unset its `kind`."
            )

    # wave_zone_NN sanity. The new authoring path (wave_zone.py) ships
    # sensible defaults but authors can scrub half-extents to zero or
    # set height_mult=0 and produce a no-op zone that silently survives
    # export.
    for obj in bpy.data.objects:
        if not _WAVE_ZONE_NAME_RE.match(obj.name):
            continue
        if obj.type != "EMPTY":
            warnings.append(
                f"`{obj.name}` matches wave_zone_NN but isn't an Empty "
                f"(type={obj.type}). Wave zones must be empties."
            )
            continue
        for prop in ("half_width", "half_height", "half_depth"):
            v = obj.get(prop)
            if v is None:
                errors.append(
                    f"`{obj.name}` is missing custom property `{prop}`. "
                    f"Wave zones need positive half-extents on all 3 axes."
                )
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                errors.append(
                    f"`{obj.name}.{prop}` is not numeric (got {v!r})."
                )
                continue
            if fv <= 0.0:
                errors.append(
                    f"`{obj.name}.{prop}` must be > 0 (got {fv}). "
                    f"A wave zone with non-positive half-extents has no volume."
                )
        hm = obj.get("height_mult")
        if hm is None:
            errors.append(
                f"`{obj.name}` is missing custom property `height_mult`. "
                f"Wave zones must declare an amplitude multiplier."
            )
        else:
            try:
                fhm = float(hm)
            except (TypeError, ValueError):
                errors.append(
                    f"`{obj.name}.height_mult` is not numeric (got {hm!r})."
                )
            else:
                if fhm <= 0.0:
                    errors.append(
                        f"`{obj.name}.height_mult` must be > 0 (got {fhm}). "
                        f"A zero multiplier makes the zone a no-op."
                    )

    return errors, warnings


def _addon_lint() -> tuple[list[str], list[str]]:
    """Delegate to the addon's existing lint pass. Imports lazily so a
    broken addon still surfaces via _enable_addon() above rather than
    raising at import time here.

    Note: ``validate_track_scene`` reads each ai_spline's ``points``
    custom prop, which is populated by ``bake_ai_splines`` at export
    time. We mirror the export sequence here so the lint sees the same
    state the runtime would: the addon's *Export to Game* button calls
    ``bake_ai_splines()`` immediately before ``validate_track_scene()``
    (see ``export.py``)."""
    from kingtide_addon.track_meta import _lint_track
    from kingtide_addon._legacy import bake_ai_splines, validate_track_scene

    # Mirror export.py — bake curves into the `points` extras first so
    # the spline-shape check has something to read.
    bake_ai_splines()

    errors, warnings = _lint_track(bpy.context.scene)
    # validate_track_scene returns strings without explicit severity;
    # surface as errors (it covers the "missing required object" /
    # "kind mismatch" / "boost-pad missing prop" cases the runtime
    # actively rejects).
    for msg in validate_track_scene():
        errors.append(msg)
    return errors, warnings


def _emit(track_id: str, severity: str, msg: str) -> None:
    """Single-line lint output for grep-ability. Severity is one of
    ``ERROR`` / ``WARNING``; both go to stdout so the Node wrapper can
    interleave them with its own prefixes deterministically."""
    print(f"[lint:{track_id}] {severity}: {msg}")


def main() -> int:
    if not _enable_addon():
        return 1

    track_id = _track_id_from_blend()

    errors: list[str] = []
    warnings: list[str] = []

    try:
        ae, aw = _addon_lint()
        errors.extend(ae)
        warnings.extend(aw)
    except Exception as exc:  # noqa: BLE001 — surface any lint internal break.
        print(
            f"[lint:{track_id}] FATAL: addon lint raised: {exc}",
            file=sys.stderr,
        )
        # Don't return early — still run the extra checks, they're
        # independent. But the run will fail.
        errors.append(f"addon lint raised: {exc}")

    try:
        ee, ew = _extra_checks(track_id)
        errors.extend(ee)
        warnings.extend(ew)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[lint:{track_id}] FATAL: extra checks raised: {exc}",
            file=sys.stderr,
        )
        errors.append(f"extra checks raised: {exc}")

    for w in warnings:
        _emit(track_id, "WARNING", w)
    for e in errors:
        _emit(track_id, "ERROR", e)

    if errors:
        print(
            f"[lint:{track_id}] FAILED — {len(errors)} error(s), "
            f"{len(warnings)} warning(s)",
            file=sys.stderr,
        )
        return 1
    print(
        f"[lint:{track_id}] OK — 0 errors, {len(warnings)} warning(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
