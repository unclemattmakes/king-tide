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
        A = free / per-prop

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
