"""Vertex-attribute authoring helper — Item 6 from docs/blender-wishlist.md.

The runtime contract for the `COLOR_0` attribute lives in
[docs/vertex-attribute-spec.md](../../docs/vertex-attribute-spec.md).
This module is the Blender-side authoring side: every procedural
`build_*.py` script writes `COLOR_0` through `set_color_attr` so the
attribute is always present and channels carry their documented
meanings.

Channel semantics by material type — keep in sync with the spec:

    Foliage / animated props (mat_foliage_*, opt-in mat_prop_*):
        R = wind sway strength (0..1)
        G = AO multiplier      (0..1)
        B = phase offset       (0..1, wraps to 0..2π in shader)
        A = free / per-prop    (static vinyl props: 1 - edge-wear convexity,
                                1 = flat, <1 = convex ridge; material reads 1-A)

    Terrain (mat_track_*):
        R = reserved
        G = AO multiplier
        B = path-worn mask     (0..1, 1 = heavily worn)
        A = biome blend        (0..1)
"""
from __future__ import annotations

from typing import Callable, Iterable

SCHEMA_VERSION = 1
CANONICAL_NAME = "COLOR_0"

# Channel index constants (alias for readability at call sites).
R, G, B, A = 0, 1, 2, 3

# Documented "kind" tags for default values — pick the right preset at
# the bottom of build_*.py to fill channels you don't care about with
# the right defaults instead of zeroes.
FOLIAGE_CHANNELS = {"R": "sway", "G": "ao", "B": "phase", "A": "free"}
TERRAIN_CHANNELS = {"R": "reserved", "G": "ao", "B": "path_worn", "A": "biome"}

# Sensible fallback when a builder forgets to set a channel. AO defaults
# to 1.0 (no darkening); other channels default to 0.0.
DEFAULT_FOLIAGE = (0.0, 1.0, 0.0, 1.0)
DEFAULT_TERRAIN = (1.0, 1.0, 0.0, 0.0)


def welded_convexity(mesh, gain: float = 1.6, weld_decimals: int = 5) -> "list[float]":
    """Per-vertex convex-edge strength in ``[0, 1]`` (0 = flat/concave, 1 = a
    sharp convex ridge), computed on a POSITION-WELDED view of *mesh* and
    index-aligned with ``mesh.vertices``.

    Hard-surface props split their vertices along every hard edge, so a naive
    per-vertex measure only sees coplanar in-face edges (perpendicular to the
    face normal → convexity ~0) and the prop reads flat. Welding by position
    reconnects the corners: dedupe coincident verts, recompute a smooth
    per-position normal from the incident faces, average ``dot(edge dir,
    normal)`` over the welded neighbours (convex verts trend negative, so
    negate), and map the result back onto every original vertex sharing the
    position.

    The runtime painterly-vinyl material reads ``(1 - A)`` where ``A = 1 -
    convexity`` to drybrush raised edges. Mirrors
    ``tools/blender/patch_convexity.py`` and
    ``src/engine/render/edge-wear-convexity.ts`` so the source bake, the GLB
    retrofit, and the in-engine primitive stamp all agree.
    """
    import math as _math

    n = len(mesh.vertices)
    if n == 0:
        return []

    # Weld vertices by quantized position. Coincident split verts share an
    # exact position so any precision merges them; this only bounds how close
    # two distinct verts may sit before folding together (1e-5 m = 0.01 mm).
    q = 10 ** weld_decimals
    key_to_u: dict = {}
    orig2uniq = [0] * n
    upos: list = []
    for i, v in enumerate(mesh.vertices):
        co = v.co
        key = (round(co.x * q), round(co.y * q), round(co.z * q))
        u = key_to_u.get(key)
        if u is None:
            u = len(upos)
            key_to_u[key] = u
            upos.append((co.x, co.y, co.z))
        orig2uniq[i] = u
    un = len(upos)

    # Smooth per-position normal (Newell, accumulated over incident faces) +
    # the set of unique welded edges. Reads ``mesh.polygons`` directly — robust
    # across Blender versions and quad/ngon kit parts, no triangulation needed.
    nx = [0.0] * un
    ny = [0.0] * un
    nz = [0.0] * un
    edges: set = set()
    for poly in mesh.polygons:
        uvs = [orig2uniq[vi] for vi in poly.vertices]
        m = len(uvs)
        if m < 3:
            continue
        fx = fy = fz = 0.0
        for k in range(m):
            x0, y0, z0 = upos[uvs[k]]
            x1, y1, z1 = upos[uvs[(k + 1) % m]]
            fx += (y0 - y1) * (z0 + z1)
            fy += (z0 - z1) * (x0 + x1)
            fz += (x0 - x1) * (y0 + y1)
            a, b = uvs[k], uvs[(k + 1) % m]
            if a != b:
                edges.add((a, b) if a < b else (b, a))
        for u in set(uvs):
            nx[u] += fx
            ny[u] += fy
            nz[u] += fz

    # Accumulate dot(edge dir, unit normal) per welded vertex over unique edges.
    sums = [0.0] * un
    cnts = [0] * un
    for a, b in edges:
        ax, ay, az = upos[a]
        bx, by, bz = upos[b]
        ex, ey, ez = bx - ax, by - ay, bz - az
        el = _math.sqrt(ex * ex + ey * ey + ez * ez)
        if el < 1e-9:
            continue
        nla = _math.sqrt(nx[a] ** 2 + ny[a] ** 2 + nz[a] ** 2) or 1.0
        sums[a] += (ex * nx[a] + ey * ny[a] + ez * nz[a]) / (el * nla)
        cnts[a] += 1
        nlb = _math.sqrt(nx[b] ** 2 + ny[b] ** 2 + nz[b] ** 2) or 1.0
        sums[b] += (-ex * nx[b] - ey * ny[b] - ez * nz[b]) / (el * nlb)
        cnts[b] += 1

    uconv = [0.0] * un
    for u in range(un):
        if cnts[u]:
            uconv[u] = max(0.0, min(1.0, -(sums[u] / cnts[u]) * gain))
    return [uconv[orig2uniq[i]] for i in range(n)]


def set_static_prop_color0(mesh, base_rgb: "tuple[float, float, float]" = (1.0, 1.0, 0.0),
                           name: str = CANONICAL_NAME):
    """Stamp the static-vinyl-prop ``COLOR_0``: ``R, G, B`` from *base_rgb*
    (default ``G = AO = 1`` so the prop isn't darkened) and ``A = 1 -
    welded_convexity`` so the painterly-vinyl material drybrushes its raised
    edges. The single contract a procedural prop builder needs — used by
    ``build_prop.py`` and mirrored by ``condition_ai_mesh``."""
    conv = welded_convexity(mesh)
    r, g, b = base_rgb
    return set_color_attr(mesh, lambda i, _co: (r, g, b, 1.0 - conv[i]), name=name)


def set_color_attr(
    mesh,
    value_for: Callable[[int, "tuple[float, float, float]"], "tuple[float, float, float, float]"],
    name: str = CANONICAL_NAME,
    domain: str = "POINT",
):
    """Create or overwrite a Float Color attribute on *mesh* whose
    values are provided by the callback ``value_for(index, coord)``.

    Args:
        mesh: a ``bpy.types.Mesh`` data-block.
        value_for: ``(vertex_index, (x, y, z)) -> (r, g, b, a)``. The
            coord is the mesh-local position. All channels in
            ``[0.0, 1.0]``; values outside that range will be clamped
            by Blender on Float Color attributes anyway.
        name: attribute name. Defaults to the canonical ``COLOR_0``.
        domain: ``"POINT"`` for per-vertex (default) or ``"CORNER"`` for
            per-loop. POINT is what the runtime expects; CORNER is only
            for cases where the value must vary across a face's
            adjacent verts (rare).
    """
    # Remove a prior attribute with the same name so the type/domain
    # always matches the call site's intent.
    if name in mesh.color_attributes:
        mesh.color_attributes.remove(mesh.color_attributes[name])

    attr = mesh.color_attributes.new(name=name, type="FLOAT_COLOR", domain=domain)

    if domain == "POINT":
        for i, v in enumerate(mesh.vertices):
            r, g, b, a = value_for(i, (v.co.x, v.co.y, v.co.z))
            attr.data[i].color = (float(r), float(g), float(b), float(a))
    elif domain == "CORNER":
        # Per-loop: walk loops, look up their vertex coord.
        for li, loop in enumerate(mesh.loops):
            vi = loop.vertex_index
            v = mesh.vertices[vi]
            r, g, b, a = value_for(vi, (v.co.x, v.co.y, v.co.z))
            attr.data[li].color = (float(r), float(g), float(b), float(a))
    else:
        raise ValueError(f"set_color_attr: domain must be POINT or CORNER, got {domain!r}")

    return attr


def set_constant(mesh, color: "tuple[float, float, float, float]", name: str = CANONICAL_NAME):
    """Fill the attribute with a single colour for every vertex.
    Useful for procedural meshes that don't need varying parameters
    but should still carry a valid `COLOR_0`."""
    set_color_attr(mesh, lambda i, co: color, name=name)


def set_linear_sway_z(
    mesh,
    *,
    z_min: float = 0.0,
    z_max: float = 4.0,
    ao: float = 1.0,
    phase=0.0,
    name: str = CANONICAL_NAME,
):
    """Convenience preset for foliage: R ramps linearly from 0 at
    z_min to 1 at z_max (trunk → leaf-tip gradient), G = ao, B = phase,
    A = 1.

    ``phase`` is the B channel (animation phase offset in ``[0, 1)``).
    It is either a constant float (default ``0.0``) or a callable
    ``phase_for(i, co) -> float`` so a builder can author *per-vertex*
    phase variation directly into the GLB — e.g. a palm giving each frond
    its own phase so the fronds of a single palm don't sway in lockstep.
    The default of ``0.0`` preserves the prior behaviour (GN scatter or the
    runtime per-mesh hash supplies desync). See
    [docs/vertex-attribute-spec.md](../../docs/vertex-attribute-spec.md).
    """
    z_range = max(z_max - z_min, 1e-6)
    phase_for = phase if callable(phase) else (lambda i, co: phase)

    def value_for(i, co):
        sway = max(0.0, min(1.0, (co[2] - z_min) / z_range))
        return (sway, ao, float(phase_for(i, co)), 1.0)

    return set_color_attr(mesh, value_for, name=name)


def set_terrain_defaults(mesh, name: str = CANONICAL_NAME):
    """Fill terrain meshes with reasonable defaults: R reserved (1),
    G AO (1, full bright — bake a real AO pass later), B path-worn (0,
    pristine), A biome (0, default biome). Builders that want to
    author actual masks should call `set_color_attr` directly."""
    return set_constant(mesh, DEFAULT_TERRAIN, name=name)


def assert_present(mesh, name: str = CANONICAL_NAME):
    """Raise if the named color attribute is missing. Called by tests
    and the export validator to catch builder bugs that forget to write
    `COLOR_0` on a procedural mesh."""
    if name not in mesh.color_attributes:
        raise AssertionError(
            f"vertex-attr spec violation: mesh {mesh.name!r} has no `{name}` color attribute. "
            f"See docs/vertex-attribute-spec.md."
        )
