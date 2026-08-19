"""Pure-Python port of the runtime PropLine expansion.

This MUST stay byte-for-byte equivalent to the TypeScript
``src/game/tracks/prop-lines.ts`` (and the Catmull-Rom sampler +
``mulberry32`` RNG it builds on) so the Blender authoring preview spawns the
exact same instances the game does. The cross-language drift test
``tools/blender/test_propline_expand.py`` locks both sides to one golden
fixture; if you touch the math here OR in the TS, regenerate the golden
(``HB_REGEN=1 npx vitest run tests/unit/prop-lines.test.ts``) and re-run the
drift test.

Deliberately ``bpy``-free so it can run under plain CPython in CI. The Blender
operator side (``propline_placements.py``) imports this and only adds the
axis-swap + object spawning.

Coordinates here are three.js space (the JSON's space). The caller converts
to Blender axes.
"""

from __future__ import annotations

import math
from typing import Any

DEG2RAD = math.pi / 180.0

# ── FROZEN constants — must equal prop-lines.ts. ─────────────────────────────
DIVISIONS_PER_SEGMENT = 12
TENSION = 0.5
_KNUTH = 0x9E3779B1
_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193
_U32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """32-bit multiply low word — matches JS ``Math.imul`` (sign-agnostic)."""
    return ((a & _U32) * (b & _U32)) & _U32


def fnv1a32(s: str) -> int:
    h = _FNV_OFFSET & _U32
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * _FNV_PRIME) & _U32
    return h & _U32


def _make_rng(seed: int):
    """mulberry32 — exact port of ``src/engine/sim/rng.ts::createRng``."""
    s = seed & _U32
    if s == 0:
        s = 0x12345678
    state = {"s": s}

    def nxt() -> float:
        state["s"] = (state["s"] + 0x6D2B79F5) & _U32
        t = state["s"]
        t = _imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & _U32)) & _U32
        return ((t ^ (t >> 14)) & _U32) / 4294967296.0

    return nxt


# ── Catmull-Rom (port of src/game/tracks/catmull-rom.ts) ─────────────────────
def _wrap(i: int, n: int, closed: bool) -> int:
    if closed:
        return ((i % n) + n) % n
    return max(0, min(n - 1, i))


def _blend(v0: float, v1: float, v2: float, v3: float, t: float, t2: float, t3: float, k: float) -> float:
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    m1 = k * (v2 - v0)
    m2 = k * (v3 - v1)
    return h00 * v1 + h10 * m1 + h01 * v2 + h11 * m2


def _cr_point(p0, p1, p2, p3, t: float, k: float):
    t2 = t * t
    t3 = t2 * t
    return {
        "x": _blend(p0["x"], p1["x"], p2["x"], p3["x"], t, t2, t3, k),
        "y": _blend(p0["y"], p1["y"], p2["y"], p3["y"], t, t2, t3, k),
        "z": _blend(p0["z"], p1["z"], p2["z"], p3["z"], t, t2, t3, k),
    }


def sample_catmull_rom(anchors: list, divisions: int, closed: bool, tension: float) -> list:
    n = len(anchors)
    if n == 0:
        return []
    if n == 1:
        return [dict(anchors[0])]
    if n == 2:
        out = []
        segs = 2 if closed else 1
        for sgi in range(segs):
            a = anchors[sgi]
            b = anchors[(sgi + 1) % 2]
            for i in range(divisions):
                t = i / divisions
                out.append(
                    {
                        "x": a["x"] + (b["x"] - a["x"]) * t,
                        "y": a["y"] + (b["y"] - a["y"]) * t,
                        "z": a["z"] + (b["z"] - a["z"]) * t,
                    }
                )
        return out
    out = []
    seg_count = n if closed else n - 1
    for i in range(seg_count):
        p0 = anchors[_wrap(i - 1, n, closed)]
        p1 = anchors[i]
        p2 = anchors[_wrap(i + 1, n, closed)]
        p3 = anchors[_wrap(i + 2, n, closed)]
        for sgi in range(divisions):
            t = sgi / divisions
            out.append(_cr_point(p0, p1, p2, p3, t, tension))
    return out


# ── Arc-length walk + expansion (port of prop-lines.ts) ──────────────────────
def _arc_lengths(P: list, closed: bool):
    seg_count = len(P) if closed else len(P) - 1
    cum = [0.0] * (seg_count + 1)
    for i in range(seg_count):
        a = P[i]
        b = P[(i + 1) % len(P)]
        cum[i + 1] = cum[i] + math.hypot(b["x"] - a["x"], b["z"] - a["z"])
    return cum, seg_count


def _sample_at_dist(P: list, cum: list, seg_count: int, dist: float):
    total = cum[seg_count]
    d = min(max(dist, 0.0), total)
    seg = 0
    while seg < seg_count - 1 and cum[seg + 1] < d:
        seg += 1
    seg_start = cum[seg]
    seg_len = cum[seg + 1] - seg_start
    frac = (d - seg_start) / seg_len if seg_len > 0 else 0.0
    a = P[seg]
    b = P[(seg + 1) % len(P)]
    tan_x = b["x"] - a["x"]
    tan_z = b["z"] - a["z"]
    length = math.hypot(tan_x, tan_z)
    if length > 1e-9:
        tan_x /= length
        tan_z /= length
    else:
        tan_x = 0.0
        tan_z = 1.0
    pos = {
        "x": a["x"] + (b["x"] - a["x"]) * frac,
        "y": a["y"] + (b["y"] - a["y"]) * frac,
        "z": a["z"] + (b["z"] - a["z"]) * frac,
    }
    return pos, tan_x, tan_z


def prop_line_count(line: dict, total_arc_len: float) -> int:
    if line.get("spacingMode", "arcLength") == "count":
        return max(1, round(line.get("count", 1)))
    return max(1, round(total_arc_len / max(1e-3, line.get("spacingM", 1))))


# ── Source resolution (anchors OR a slice of the bound main spline) ──────────
def _clamp01(t: float) -> float:
    if not (t > 0):
        return 0.0
    if t > 1:
        return 1.0
    return t


def slice_main_spline_for_bind(bind: dict, main_points: list | None):
    """Mirror of ``sliceMainSplineForBind`` in prop-lines.ts. Integer-only index
    math (``math.floor``) so the slice is byte-identical to JS."""
    if not main_points or len(main_points) < 2:
        return None
    M = len(main_points)
    t0_raw = bind.get("t0")
    t1_raw = bind.get("t1")
    t0 = _clamp01(t0_raw if t0_raw is not None else 0.0)
    t1 = _clamp01(t1_raw if t1_raw is not None else 1.0)
    if t0 == 0 and t1 == 1:
        return {"points": [{"x": p["x"], "y": p["y"], "z": p["z"]} for p in main_points], "closed": True}
    i0 = min(int(math.floor(t0 * M)), M - 1)
    i1 = min(int(math.floor(t1 * M)), M - 1)
    points = []
    i = i0
    while True:
        p = main_points[i]
        points.append({"x": p["x"], "y": p["y"], "z": p["z"]})
        if i == i1:
            break
        i = (i + 1) % M
    return {"points": points, "closed": False}


def resolve_prop_line_source(line: dict, main_spline_points: list | None):
    """Mirror of ``resolvePropLineSource`` — the dense source polyline + closed
    flag a line expands along (anchors, or a slice of the bound main spline).

    Use ``is not None`` (NOT truthiness): a full-loop bind is the empty dict
    ``{}``, which is truthy in JS but FALSY in Python — checking truthiness here
    would silently drop full-loop binds and diverge from the runtime."""
    if line.get("bind") is not None:
        return slice_main_spline_for_bind(line["bind"], main_spline_points)
    anchors = line.get("anchors") or []
    if len(anchors) < 2:
        return None
    closed = bool(line.get("closed", False))
    points = sample_catmull_rom(anchors, DIVISIONS_PER_SEGMENT, closed, TENSION)
    return {"points": points, "closed": closed}


def _round_half_to_even_to_js(x: float) -> int:
    """JS ``Math.round`` rounds .5 toward +Infinity; Python ``round`` is
    banker's rounding. Match JS so the count agrees."""
    return math.floor(x + 0.5)


def expand_prop_line(line: dict, main_spline_points: list | None = None) -> list:
    """Expand one PropLine dict (three.js space) into a list of prop dicts:
    ``{assetId, position:{x,y,z}, rotation:{x,y,z,w}, size, ...}``.
    Mirrors ``expandPropLine`` in prop-lines.ts exactly.

    ``main_spline_points`` supplies the racing line for a spline-bound line
    (``bind``); the SAME points must be threaded in by every caller for the
    bound expansion to stay cross-language identical. Ignored for anchor lines."""
    src = resolve_prop_line_source(line, main_spline_points)
    if not src:
        return []
    closed = src["closed"]
    P = src["points"]
    if len(P) < 2:
        return []
    cum, seg_count = _arc_lengths(P, closed)
    total = cum[seg_count]
    if not (total > 0):
        return []

    # JS Math.round semantics for the count.
    if line.get("spacingMode", "arcLength") == "count":
        N = max(1, _round_half_to_even_to_js(line.get("count", 1)))
    else:
        N = max(1, _round_half_to_even_to_js(total / max(1e-3, line.get("spacingM", 1))))

    seed0 = fnv1a32(line["id"])
    offset_m = line.get("offsetM", 0.0)
    normal_offset_m = line.get("normalOffsetM", 0.0)
    align_to_tangent = line.get("alignToTangent", True)
    yaw_const = line.get("yawDeg", 0.0) * DEG2RAD
    base_scale = line.get("scale", 1.0)
    jitter = line.get("jitter") or {}
    j_pos_m = jitter.get("posM", 0.0)
    j_yaw_rad = jitter.get("yawDeg", 0.0) * DEG2RAD
    j_scale_min = jitter.get("scaleMin", 1.0)
    j_scale_max = jitter.get("scaleMax", 1.0)

    out = []
    for i in range(N):
        if closed:
            f = i / N
        elif N == 1:
            f = 0.5
        else:
            f = i / (N - 1)
        pos, tan_x, tan_z = _sample_at_dist(P, cum, seg_count, f * total)

        rng = _make_rng((seed0 ^ (_imul(i, _KNUTH) & _U32)) & _U32)
        j_angle = rng() * 2 * math.pi
        j_radius = rng() * j_pos_m
        j_yaw = (rng() * 2 - 1) * j_yaw_rad
        j_scale = j_scale_min + rng() * (j_scale_max - j_scale_min)

        left_x = -tan_z
        left_z = tan_x
        x = pos["x"] + left_x * offset_m + math.cos(j_angle) * j_radius
        z = pos["z"] + left_z * offset_m + math.sin(j_angle) * j_radius
        y = pos["y"] + normal_offset_m

        tan_yaw = math.atan2(tan_x, tan_z) if align_to_tangent else 0.0
        yaw = tan_yaw + yaw_const + j_yaw
        half = yaw / 2
        s = base_scale * j_scale

        prop: dict[str, Any] = {
            "type": "asset",
            "assetId": line["assetId"],
            "position": {"x": x, "y": y, "z": z},
            "rotation": {"x": 0.0, "y": math.sin(half), "z": 0.0, "w": math.cos(half)},
            "size": {"x": s, "y": s, "z": s},
            "fromPropLine": True,
        }
        if line.get("surface"):
            prop["surface"] = line["surface"]
        if line.get("waveRider"):
            prop["waveRider"] = {"dof": line["waveRider"].get("dof", "locked")}
        if line.get("waterline") is False:
            prop["waterline"] = False
        out.append(prop)
    return out


def expand_prop_lines(lines: list, main_spline_points: list | None = None) -> list:
    out = []
    for line in lines:
        out.extend(expand_prop_line(line, main_spline_points))
    return out
