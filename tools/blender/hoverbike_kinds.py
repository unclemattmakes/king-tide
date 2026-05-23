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

    # Distant horizon silhouette mesh — a ring of background terrain
    # the runtime camera-locks to the player so the world has a
    # tangible far-field shape instead of an empty fog gradient. One
    # per track. Authors drop a starter ring via the addon's
    # ``Add Horizon Ring`` operator, then tab into edit mode to push /
    # pull verts into recognizable skyline silhouettes (Skytree for
    # Shibuya, Table Mountain for Cape Town, etc.). The runtime
    # extracts the mesh from the GLB on load and feeds its geometry
    # into ``createHorizonRing`` instead of the procedural fallback.
    # Skipped by the trimesh-collider attach step — the ring is
    # 1.4 km away and render-only by design.
    HORIZON = "horizon"

    # Particle-emitter empty — a spawn point + orientation for the
    # shared particle system. Each ``emitter_NN`` carries a fixed
    # extras block (``atlas_cell``, ``emit_rate``, ``lifetime_s``,
    # ``velocity_cone_deg``, ``speed_min``/``speed_max``,
    # ``size_start``/``size_end``, ``color_start``/``color_end``,
    # ``gravity``, ``max_particles``) that the runtime reads at GLB
    # load and registers with ``createParticleSystem``. The empty's
    # transform is the spawn pose; particles emit along local +Y
    # within ``velocity_cone_deg`` half-cone. Skipped by the trimesh-
    # collider attach step — emitters are render-only.
    EMITTER = "emitter"

    # Wave-mastery volume zone — an oriented box ``wave_zone_NN`` empty
    # carries (position, rotation, half_width, half_height, half_depth)
    # plus per-zone multipliers on the global Gerstner wave field. The
    # box's local +X is the dominant swell direction. Lets authors give
    # The Maw a tall central swell, Aqualand a periodic tsunami surge,
    # and Hatteras heavier chop on one half-loop without rebuilding the
    # global wave field per track. Soft-blended across ``blend_radius``
    # so amplitude doesn't pop at the OBB face.
    WAVE_ZONE = "wave_zone"

    # Decal mesh — thin projected quad pasted on top of terrain / road
    # geometry to add wear, paint, posters, oil stains, etc. Authored
    # as ``decal_NN`` meshes (not empties) in Blender via the addon's
    # *Add Decal* operator. Carries an ``atlas_cell`` extra (0..15) that
    # picks a 256×256 tile from ``public/assets/decals/atlas.png``. The
    # runtime walks all kind=decal meshes on load and applies the decal
    # material profile: shared atlas-textured material, alpha-blend on,
    # depth-test ON / write OFF, slight polygon offset to avoid
    # z-fighting with the surface, no shadow cast/receive. Skipped by
    # the trimesh-collider attach step — decals are render-only.
    DECAL = "decal"

    # Wave-rider marker. Reserved for future authoring sites that want
    # to flag a non-prop node as a wave-rider (track-baked floating
    # debris, scattered marker buoys, etc.). The current asset-prop
    # flow keeps ``kind = prop`` on the root empty and uses a sibling
    # extras key ``wave_rider_archetype: "buoy" | "log"`` to mark the
    # asset as wave-riding — that path preserves backward compat with
    # every track GLB / loader site that already special-cases
    # ``kind == "prop"``. Adding the dedicated kind here lets future
    # pipelines (e.g. inline wave-rider markers in a track GLB) use a
    # single-extras tag without the prop indirection.
    WAVE_RIDER = "wave_rider"


class AuthoringKind:
    """Object extras kinds used only inside Blender — never shipped."""

    # The bezier curve a road is built from. The road operator reads
    # the curve and emits a swept mesh with kind=track; the curve
    # itself is excluded from export.
    ROAD_CURVE = "road_curve"

    # The bezier curve a tunnel is built from. Same story — the swept
    # interior ships as kind=track, the curve does not.
    TUNNEL_CURVE = "tunnel_curve"

    # The bezier curve an anti-grav ribbon is built from. The Build
    # Anti-Grav Surface operator reads the curve, sweeps the chosen
    # cross-section profile into a ``kind=track`` mesh, and drops
    # ``antigrav_zone`` empties at each endpoint to flip gravity inside
    # the volume. The curve itself never ships.
    ANTIGRAV_CURVE = "antigrav_curve"

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

    # Hero camera used by the headless track-thumbnail render — a
    # Camera object named ``camera_hero`` framed on the track's set-
    # piece. Read by ``tools/blender/render_track_thumbnail.py`` and by
    # the addon's *Render Track Hero* operator, which writes a 1280×720
    # JPG to ``public/assets/tracks/<id>-hero.jpg`` for the loading
    # screen + a 320×180 thumbnail tile. The runtime never sees this
    # camera: the glTF exporter is invoked with
    # ``export_cameras=False`` so cameras never reach the GLB, and the
    # runtime always uses its own chase cam.
    CAMERA_HERO = "camera_hero"


# Convenience tuples for tests / consumers that want to iterate.
EXPORTED_KIND_VALUES: tuple[str, ...] = tuple(
    v for k, v in vars(ExportedKind).items() if not k.startswith("_") and isinstance(v, str)
)
AUTHORING_KIND_VALUES: tuple[str, ...] = tuple(
    v for k, v in vars(AuthoringKind).items() if not k.startswith("_") and isinstance(v, str)
)
ALL_KIND_VALUES: tuple[str, ...] = EXPORTED_KIND_VALUES + AUTHORING_KIND_VALUES
