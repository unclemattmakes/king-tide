"""Single source of truth for the ``obj["kind"]`` extras values used
across the Blender addon, the seed scripts, and the runtime.

Background: the same string value is set in Python (when the Blender
side tags an object) and read in TypeScript (when the runtime
classifies a loaded glTF node). Until this file existed, both sides
just inlined the literal — and the inevitable happened: subtle
typos / over-broad matches like ``kind == "track"`` accidentally
sweeping up downtown buildings, ramps, and tunnel interiors caused
visible bugs that were caught only by playtest.

The companion file in TypeScript is ``src/engine/asset-kinds.ts``;
the unit test ``tests/unit/asset-kinds.test.ts`` parses this file and
asserts the ``ExportedKind`` values match. Add a value here AND
there — the unit test will fail loud if you only add it to one side.

Distinction:

  * ``ExportedKind`` — values that ship inside the GLB's gltf extras
    and are read by the runtime (``obj.userData.kind === "..."``).
    Mirrored in ``asset-kinds.ts``. Renaming any value is a breaking
    change for already-built GLBs.

  * ``AuthoringKind`` — values used only inside Blender during
    authoring (curves, cutters, profiles, helpers). The export
    pipeline either skips these objects or transforms them into
    something else before the GLB is written, so the runtime never
    sees them. Not mirrored in TypeScript.

Use the constants instead of the string literals at all new sites,
and migrate old call sites opportunistically. A future migration PR
will sweep the remaining literal sites in ``hoverbike_addon.py`` and
``seed_*.py``.
"""

from __future__ import annotations


class ExportedKind:
    """Object extras kinds that flow Blender → glTF → runtime."""

    # Collidable terrain/walls/road/buildings. Runtime spawns a trimesh
    # collider against every mesh with this kind. Beware of over-matching:
    # historically `kind === "track"` accidentally caught downtown
    # buildings AND ramps AND tunnel liners, and the terrain shader
    # replaced their materials. Use this kind for things the bike's
    # physics should collide with; use material-name detection (not
    # kind) when you need to single out actual terrain.
    TRACK = "track"

    # Water-volume markers — empties placed at the surface; runtime
    # reads their location.z for sea level + spawns the water plane.
    WATER = "water"

    # Gate position empties. Runtime uses these to spawn checkpoint
    # gizmos and gate triggers.
    CHECKPOINT = "checkpoint"

    # The AI's racing-line curve. One per track. Runtime samples it to
    # drive AI bikes.
    AI_SPLINE = "ai_spline"

    # Pickup spawn markers. Runtime uses to spawn powerups.
    PICKUP_SPAWN = "pickup_spawn"

    # Bike start position empties. There can be multiple (grid starts).
    START = "start"

    # Speed-boost pad. Runtime spawns a boost trigger at the empty's pose.
    BOOST_PAD = "boost_pad"

    # Bike root empty — every bike GLB carries exactly one. Runtime
    # mounts the rest of the bike's hierarchy under this.
    BIKE = "bike"

    # Bike socket — attachment points (handlebars, seat, foot pegs).
    # Runtime expects an accompanying `slot` extra naming the socket.
    SOCKET = "socket"

    # Primitive collider — box/sphere/cylinder. Runtime expects
    # accompanying `shape` + dimension extras (`half_extents`, `radius`,
    # `height`, etc.) describing the primitive.
    COLLIDER = "collider"

    # Prop root empty — every prop GLB carries exactly one.
    PROP = "prop"

    # Anti-gravity volume zone — an oriented box ``antigrav_NN`` empty
    # carries (position, rotation, half_width, half_height, half_depth)
    # custom props. Inside the box, gravity flips to the zone's local
    # +Y. Authoring complements the spline-tilt mechanism (which handles
    # the main route); zones cover off-route prop roads / ad-hoc spots
    # where there isn't a curve to sample.
    ANTIGRAV_ZONE = "antigrav_zone"


class AuthoringKind:
    """Object extras kinds used only inside Blender — never shipped."""

    # The bezier curve a road is built from. The road operator reads
    # the curve and emits a swept mesh with kind=track; the curve
    # itself is excluded from export.
    ROAD_CURVE = "road_curve"

    # The bezier curve a tunnel is built from. Same story — the swept
    # interior ships as kind=track, the curve does not.
    TUNNEL_CURVE = "tunnel_curve"

    # The closed-cap swept mesh used as the operand of the terrain's
    # Boolean DIFFERENCE modifier. Never exported; hidden from render.
    TUNNEL_CUTTER = "tunnel_cutter"

    # The 2-D bezier cross-section that the tunnel sweep extrudes
    # along the tunnel curve. Authors edit it to reshape the tunnel's
    # silhouette; never exported.
    TUNNEL_PROFILE = "tunnel_profile"

    # Empties dropped by the placement helper to mark spots while
    # authoring. Stripped by the export pipeline.
    PLACEMENT_HELPER = "placement_helper"

    # Per-template authoring markers (oasis center on the dunes
    # template, mesa tops on the mesa template). These tag template-
    # specific authoring landmarks the seeds drop for convenience.
    OASIS_CENTER = "oasis_center"
    MESA = "mesa"


# Convenience tuples for tests / consumers that want to iterate.
EXPORTED_KIND_VALUES: tuple[str, ...] = tuple(
    v for k, v in vars(ExportedKind).items() if not k.startswith("_") and isinstance(v, str)
)
AUTHORING_KIND_VALUES: tuple[str, ...] = tuple(
    v for k, v in vars(AuthoringKind).items() if not k.startswith("_") and isinstance(v, str)
)
ALL_KIND_VALUES: tuple[str, ...] = EXPORTED_KIND_VALUES + AUTHORING_KIND_VALUES
