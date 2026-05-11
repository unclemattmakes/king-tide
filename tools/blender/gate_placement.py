"""Gate placement algorithm — Python port of src/game/tracks/gate-placement.ts.

Both the in-app track editor (TypeScript) and the Blender-side gate preview
must produce identical gate positions for the same (spline, spacing) input,
so this file mirrors the TypeScript algorithm byte-for-byte. Any change
here must be mirrored in `gate-placement.ts` and the matching Vitest case.

Coordinate note:
    The TypeScript runtime uses Y-up; arc length there is measured in xz.
    Blender authors in Z-up; arc length here is measured in xy. The
    horizontal-axis pair is configurable via the `vertical_axis` param so
    callers can be explicit when crossing between the two worlds.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

DEFAULT_GATE_SPACING_M = 60.0


def resample_by_arc_length(
    points: Sequence[tuple[float, float, float]],
    target_spacing: float,
    *,
    vertical_axis: int = 2,
) -> list[dict]:
    """Resample a closed AI spline polyline by arc length.

    Returns a list of dicts with keys ``t`` (parameter in [0, 1)),
    ``position`` (3-tuple in input space), and ``tangent`` (unit vector
    in the horizontal plane).

    Gate count is rounded to fit the closed loop cleanly:
    ``N = max(1, round(total_length / target_spacing))``.

    Args:
        points: Closed-loop dense polyline (segment N-1 → 0 closes it).
        target_spacing: Desired spacing in metres. Must be > 0.
        vertical_axis: Index (0/1/2) of the up axis to ignore in arc
            measurement. Defaults to 2 (Blender / Z-up). Pass 1 for
            three.js / Y-up.
    """
    if len(points) < 2:
        return []
    if not (target_spacing > 0):
        raise ValueError(
            f"resample_by_arc_length: target_spacing must be positive (got {target_spacing})"
        )

    horiz = [i for i in range(3) if i != vertical_axis]
    n = len(points)
    cum = [0.0] * (n + 1)
    for i in range(n):
        a = points[i]
        b = points[(i + 1) % n]
        d0 = b[horiz[0]] - a[horiz[0]]
        d1 = b[horiz[1]] - a[horiz[1]]
        cum[i + 1] = cum[i] + math.hypot(d0, d1)
    total = cum[n]
    if total == 0:
        return []

    gate_count = max(1, round(total / target_spacing))
    placements: list[dict] = []
    seg = 0
    for i in range(gate_count):
        target = (i / gate_count) * total
        while seg < n - 1 and cum[seg + 1] < target:
            seg += 1
        seg_len = cum[seg + 1] - cum[seg]
        frac = (target - cum[seg]) / seg_len if seg_len > 0 else 0.0
        t = (seg + frac) / n
        placements.append({
            "t": t,
            "position": _point_at_t(points, t),
            "tangent": _tangent_at_t(points, t, horiz),
        })
    return placements


def _point_at_t(points: Sequence[tuple[float, float, float]], t: float) -> tuple[float, float, float]:
    """Mirrors catmull-rom.ts `pointAtT` — vertex-uniform parameterisation
    of a closed polyline, NOT arc-length uniform."""
    n = len(points)
    if n == 0:
        return (0.0, 0.0, 0.0)
    if n == 1:
        return tuple(points[0])
    wrapped = ((t % 1) + 1) % 1
    f = wrapped * n
    i0 = int(f) % n
    i1 = (i0 + 1) % n
    frac = f - int(f)
    a = points[i0]
    b = points[i1]
    return (
        a[0] + (b[0] - a[0]) * frac,
        a[1] + (b[1] - a[1]) * frac,
        a[2] + (b[2] - a[2]) * frac,
    )


def _tangent_at_t(
    points: Sequence[tuple[float, float, float]],
    t: float,
    horiz: list[int],
) -> tuple[float, float, float]:
    """Mirrors catmull-rom.ts `tangentAtT`. Returns a unit vector in the
    horizontal plane; the vertical component is zero. `horiz` is the
    list of axis indices considered horizontal (see resample_by_arc_length)."""
    n = len(points)
    if n < 2:
        return (0.0, 0.0, 1.0)
    wrapped = ((t % 1) + 1) % 1
    f = wrapped * n
    i0 = int(f) % n
    i1 = (i0 + 1) % n
    a = points[i0]
    b = points[i1]
    d0 = b[horiz[0]] - a[horiz[0]]
    d1 = b[horiz[1]] - a[horiz[1]]
    length = math.hypot(d0, d1) or 1.0
    out = [0.0, 0.0, 0.0]
    out[horiz[0]] = d0 / length
    out[horiz[1]] = d1 / length
    return (out[0], out[1], out[2])


# ── Self-test (run as a script) ───────────────────────────────────────────

if __name__ == "__main__":
    # Same cases as tests/unit/gate-placement.test.ts.
    square = [(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)]  # xy plane, Z-up
    gates = resample_by_arc_length(square, 100)
    assert len(gates) == 4
    for i, expected_t in enumerate([0, 0.25, 0.5, 0.75]):
        assert abs(gates[i]["t"] - expected_t) < 1e-9, gates[i]["t"]

    # Empty / single
    assert resample_by_arc_length([], 10) == []
    assert resample_by_arc_length([(0, 0, 0)], 10) == []

    # Bad spacing
    for bad in (0, -5):
        try:
            resample_by_arc_length(square, bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"should have raised for {bad}")

    # Spacing → count
    for sp, expected in [(100, 4), (50, 8), (150, 3)]:
        assert len(resample_by_arc_length(square, sp)) == expected

    print(f"OK  square: 4 gates at t={[round(g['t'], 4) for g in gates]}")
    print("ALL PYTHON CHECKS PASS")
