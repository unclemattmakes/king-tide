"""Terrain attribute bakers — AO + path-wear + COLOR_0 stamping.

Fills the ``baked_ao`` (FLOAT) and ``baked_path`` (FLOAT) attributes
on the source terrain mesh so the GN graph can route them into
COLOR_0.G (AO multiplier) and COLOR_0.B (racing-line wear). The
seeded GN graph samples these as Named Attributes; the runtime
terrain shader reads both channels and uses them to darken cavities
and tint a worn dirt line into the surface where the racing line
runs.

AO uses Cycles' vertex-colour bake — fastest path on consumer GPUs
and handles the GN-evaluated terrain geometry correctly (Cycles
internally applies modifiers before baking). Path-wear uses a KDTree
over a densely sampled spline polyline — pure Python, ~1 s on a
150 k-vert terrain.

Path-wear knobs are scene-level (``hoverbike_path_wear_inner`` /
``_outer`` / ``_intensity``) so authors can tune width / depth from
the addon panel without re-editing the operator. See
[docs/vertex-attribute-spec.md](../../docs/vertex-attribute-spec.md)
for the channel contract.

This module also exposes ``HOVERBIKE_OT_apply_terrain_vertex_colors``
for hand-rolled terrain meshes (ANT Landscape output, heightmap
imports, sculpts) that don't carry an HV_Island-style GN graph that
would stamp ``COLOR_0`` automatically. The operator writes the
attribute directly per-vertex using the same biome / AO / path
contract.
"""

from __future__ import annotations

import bpy
from bpy.props import BoolProperty, FloatProperty
from bpy.types import Operator
from mathutils import Vector
from mathutils.kdtree import KDTree


# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

BAKED_AO_ATTR = "baked_ao"
BAKED_PATH_ATTR = "baked_path"
BAKE_TEMP_ATTR = "_hoverbike_bake_target"

# The canonical author-preview terrain material — every seed_template_*.py
# builds one of these (a 19-node graph: biome color ramp + AO + altitude /
# slope / noise overlays) and assigns it to the terrain so the viewport's
# material preview shows the sand / grass / rock bands the runtime shader
# will ultimately produce. The hand-rolled-terrain operator looks it up
# by name and reassigns it when missing — keeping the lookup central
# avoids drift if we rename or move the builder later.
TERRAIN_MATERIAL_NAME = "mat_terrain_main"

# Path-wear defaults. Inner = 0 m → full wear directly on the racing
# line; outer = 20 m → faded out beyond 20 m. The 20 m default is sized
# to span 3–4 vertices on typical heightmap-density terrain (128×128
# grid over a 1024 m extent gives ~8 m vertex spacing). Anything
# narrower bottoms out at 1-vert-wide and reads as a dotted/patchy
# trail after the GPU interpolates vertex colours across faces.
# Intensity is a [0, 1] multiplier on the final wear value, useful for
# backing the racing line off when the runtime ``pathTint`` is already
# aggressive.
DEFAULT_PATH_WEAR_INNER_M = 0.0
DEFAULT_PATH_WEAR_OUTER_M = 20.0
DEFAULT_PATH_WEAR_INTENSITY = 1.0

# Biome thresholds — world-space Z (metres). Defaults match the boundaries
# baked into ``seed_template_island``'s GN graph: deep below -22 m (open
# water), sandy/shallow between -22 and 0 m (submerged shelf), beach
# between 0 and 4 m, jungle above 4 m. The runtime terrain shader maps
# the resulting COLOR_0.A value to its four palette bands.
DEFAULT_BIOME_DEEP_Z_M = -22.0
DEFAULT_BIOME_SANDY_Z_M = 0.0
DEFAULT_BIOME_BEACH_Z_M = 4.0


# ────────────────────────────────────────────────────────────────────
# Pure math — kept as a free function so the self-test below can
# exercise it without booting Blender's depsgraph.
# ────────────────────────────────────────────────────────────────────


def path_wear_at_distance(
    distance: float,
    inner: float = DEFAULT_PATH_WEAR_INNER_M,
    outer: float = DEFAULT_PATH_WEAR_OUTER_M,
    intensity: float = DEFAULT_PATH_WEAR_INTENSITY,
) -> float:
    """Map ``distance`` (metres from the AI spline polyline) to a wear
    value in [0, 1].

    * ``distance <= inner`` → ``1.0 * intensity`` (full wear on the line).
    * ``distance >= outer`` → ``0.0`` (no wear beyond the falloff).
    * In between, follows a smoothstep from outer→inner (so wear *rises*
      as you approach the line).

    ``intensity`` is a [0, 1] multiplier on the final value (clamped to
    a sane upper bound so a runaway slider can't write values past 1).
    """
    if outer <= inner:
        # Degenerate band — collapse to a hard mask at ``inner``.
        wear = 1.0 if distance <= inner else 0.0
    elif distance <= inner:
        wear = 1.0
    elif distance >= outer:
        wear = 0.0
    else:
        # Smoothstep from outer (wear=0) → inner (wear=1).
        t = (outer - distance) / (outer - inner)
        wear = t * t * (3.0 - 2.0 * t)
    return max(0.0, min(1.0, wear * max(0.0, min(1.0, intensity))))


def biome_from_z(
    z: float,
    deep_z: float = DEFAULT_BIOME_DEEP_Z_M,
    sandy_z: float = DEFAULT_BIOME_SANDY_Z_M,
    beach_z: float = DEFAULT_BIOME_BEACH_Z_M,
) -> float:
    """Map world-space ``z`` to the COLOR_0.A biome value in {0, 1/3, 2/3, 1}.

    Mirrors the sum-of-three-step-functions formula used by
    ``seed_template_island``'s GN graph:

        biome = ((z > deep_z) + (z > sandy_z) + (z > beach_z)) / 3

    Yielding deep (0), sandy/shallow (1/3), beach (2/3), jungle (1).
    Thresholds *must* be monotonically increasing — the caller is
    expected to enforce that (the operator clamps in ``execute``).
    """
    n = 0
    if z > deep_z:
        n += 1
    if z > sandy_z:
        n += 1
    if z > beach_z:
        n += 1
    return n / 3.0


# ────────────────────────────────────────────────────────────────────
# Bake implementations
# ────────────────────────────────────────────────────────────────────


def _ensure_baked_attrs(terrain: bpy.types.Object) -> None:
    """Make sure the source terrain mesh has the baked-* attributes the
    GN graph reads. Both stored as plain FLOAT so glTF's vertex-colour
    heuristic doesn't pick them up and stomp the GN-stamped COLOR_0 in
    the export. Idempotent — pre-existing attributes are left alone."""
    me = terrain.data
    if BAKED_AO_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_AO_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 1.0  # default = no occlusion
    if BAKED_PATH_ATTR not in me.attributes:
        attr = me.attributes.new(name=BAKED_PATH_ATTR, type="FLOAT", domain="POINT")
        for i in range(len(attr.data)):
            attr.data[i].value = 0.0  # default = no wear


def _bake_ao_cycles(
    terrain: bpy.types.Object, samples: int = 16, distance: float = 30.0
) -> None:
    """Bake Cycles AO into the terrain's ``baked_ao`` FLOAT attribute.

    Cycles needs a vertex *colour* attribute as its target, but a
    FLOAT_COLOR on the source mesh would be picked up by glTF's
    auto-export heuristic and shipped as COLOR_0, fighting the
    GN-stamped COLOR_0. We work around that by creating a throwaway
    FLOAT_COLOR (``_hoverbike_bake_target``) for Cycles to write into,
    copying the R channel into the persistent ``baked_ao`` float, and
    deleting the temporary attribute on the way out. Net effect: the
    source mesh ships with only FLOAT attributes, and the GN graph's
    ``Named Attribute`` sampler reads ``baked_ao`` for COLOR_0.G."""
    scene = bpy.context.scene
    me = terrain.data
    prev_engine = scene.render.engine

    # Create the throwaway bake target.
    if BAKE_TEMP_ATTR in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])
    target = me.color_attributes.new(
        name=BAKE_TEMP_ATTR, type="FLOAT_COLOR", domain="POINT"
    )
    me.color_attributes.active_color_index = me.color_attributes.find(BAKE_TEMP_ATTR)

    scene.render.engine = "CYCLES"
    scene.cycles.bake_type = "AO"
    scene.cycles.samples = samples
    scene.render.bake.target = "VERTEX_COLORS"
    if scene.world is not None:
        try:
            scene.world.light_settings.use_ambient_occlusion = True
            scene.world.light_settings.distance = distance
        except AttributeError:
            pass

    prev_active_obj = bpy.context.view_layer.objects.active
    # ``selected_objects`` isn't available on every context (e.g. when
    # the operator runs from a non-VIEW_3D context like MCP/headless).
    prev_selection = list(getattr(bpy.context, "selected_objects", []))
    for o in prev_selection:
        o.select_set(False)
    bpy.context.view_layer.objects.active = terrain
    terrain.select_set(True)
    try:
        bpy.ops.object.bake(type="AO")
        # Transfer Cycles' RGB output (greyscale, R == G == B for AO)
        # into the persistent FLOAT attribute.
        ao_attr = me.attributes[BAKED_AO_ATTR]
        for i in range(len(target.data)):
            ao_attr.data[i].value = float(target.data[i].color[0])
    finally:
        terrain.select_set(False)
        for o in prev_selection:
            o.select_set(True)
        bpy.context.view_layer.objects.active = prev_active_obj
        scene.render.engine = prev_engine
        if BAKE_TEMP_ATTR in me.color_attributes:
            me.color_attributes.remove(me.color_attributes[BAKE_TEMP_ATTR])


def _densify_polyline_xy(
    points: list, max_step_m: float = 1.0
) -> list:
    """Insert linearly-interpolated samples into ``points`` so no
    consecutive pair spans more than ``max_step_m`` in XY ground
    distance. Z is interpolated alongside even though the path-wear
    bake collapses it — keeping it in the output means this helper
    stays generic for any other consumer that wants a dense 3D
    polyline. Returns a fresh list; input is untouched."""
    import math as _math

    if len(points) < 2:
        return list(points)
    if max_step_m <= 0:
        return list(points)

    dense = [points[0]]
    for prev, curr in zip(points, points[1:]):
        dx = curr.x - prev.x
        dy = curr.y - prev.y
        seg_len = _math.hypot(dx, dy)
        # n_extra intermediates → segment becomes (n_extra+1) sub-segments,
        # each ≤ max_step_m long. Skip if the segment already fits.
        n_extra = int(seg_len // max_step_m)
        for k in range(1, n_extra + 1):
            t = k / (n_extra + 1)
            dense.append(prev.lerp(curr, t))
        dense.append(curr)
    return dense


def _bake_path_wear(
    terrain: bpy.types.Object,
    spline: bpy.types.Object,
    *,
    inner: float = DEFAULT_PATH_WEAR_INNER_M,
    outer: float = DEFAULT_PATH_WEAR_OUTER_M,
    intensity: float = DEFAULT_PATH_WEAR_INTENSITY,
) -> int:
    """Compute per-vertex distance from the AI spline, run it through
    a smoothstep falloff, and write the result to ``baked_path`` on
    the source terrain. Reads the *evaluated* terrain mesh (post-GN)
    so vertex world positions reflect the actual displaced terrain —
    distance-from-spline only makes sense in the played world, not on
    a flat undisplaced plane. The vertex-index mapping back to the
    source mesh is one-to-one because the GN graph doesn't add or
    remove verts.

    Distance is the planar XY ground distance (Blender is Z-up). The
    spline's height — and the vertex's height — are collapsed so a
    racing line that floats above a hill still leaves wear on the
    ground beneath it, which is what authors expect: the worn band
    is where the bike *would drive*, not where the spline floats in
    3D space.

    Idempotent: re-running with the same inputs stamps the same values.

    Args:
        terrain: the source ``kind=track`` terrain mesh.
        spline: the AI racing-line curve (``ai_spline_main``).
        inner: distance (m) at which wear saturates at 1.0.
        outer: distance (m) beyond which wear is 0.0. Must be > inner
            (or the band collapses to a hard mask at ``inner``).
        intensity: [0, 1] multiplier on the final wear value.
    """
    if spline is None or spline.type != "CURVE":
        raise RuntimeError("path-wear bake needs an ai_spline_main curve")

    dg = bpy.context.evaluated_depsgraph_get()

    # Initial polyline from the curve's evaluated mesh. This respects
    # whatever resolution_u the curve is set to — which is usually
    # sparse (Blender defaults the AI spline to 12 segments per Bezier
    # span, so a 2 km track ends up with ~50 verts: ~40 m between
    # samples). Far too coarse for an 8 m wear radius, so we densify
    # below.
    cobj = spline.evaluated_get(dg)
    cme = cobj.to_mesh()
    try:
        sw = spline.matrix_world
        raw_pts = [sw @ Vector(v.co) for v in cme.vertices]
    finally:
        try:
            cobj.to_mesh_clear()
        except ReferenceError:
            pass
    if len(raw_pts) < 2:
        raise RuntimeError("ai_spline_main has too few sampled points")

    # Densify to ~1 m XY spacing. A 2 km racing line ends up with
    # ~2 k samples — well within KDTree's comfort zone — and the
    # nearest-sample distance from any terrain vertex becomes a
    # tight estimate of the actual perpendicular distance to the
    # curve. Without densification, the curve's evaluated mesh ships
    # at whatever resolution_u the curve has (Blender defaults gave
    # ~50 samples on the test track, ~40 m apart — way coarser than
    # the 8 m wear band, so the worn region read as a dotted line
    # of disks instead of a continuous band).
    spline_pts = _densify_polyline_xy(raw_pts, max_step_m=1.0)

    # Project to the XY ground plane (Blender is Z-up): collapse Z so
    # a vertex *under* the racing line — on a hill where the spline
    # floats well above the terrain — still picks up wear, which is
    # what authors expect: the worn band is where the bike *would
    # drive*, not where the spline floats in 3D.
    tree = KDTree(len(spline_pts))
    for i, p in enumerate(spline_pts):
        tree.insert(Vector((p.x, p.y, 0.0)), i)
    tree.balance()

    eobj = terrain.evaluated_get(dg)
    eme = eobj.to_mesh()
    n_verts = 0
    try:
        if len(eme.vertices) != len(terrain.data.vertices):
            raise RuntimeError(
                f"vertex-count mismatch (source {len(terrain.data.vertices)}, "
                f"evaluated {len(eme.vertices)}) — GN graph appears to add/remove verts"
            )
        mw = terrain.matrix_world
        path_attr = terrain.data.attributes[BAKED_PATH_ATTR]
        n_verts = len(eme.vertices)
        # Both stored points and queries live on the z=0 plane, so the
        # KDTree's 3D nearest-neighbour distance is the planar XY
        # ground distance from the vertex to the racing line — exactly
        # what path-worn wants (the bike's racing footprint, not the
        # spline's possibly-elevated 3D arc).
        for i, v in enumerate(eme.vertices):
            world = mw @ Vector(v.co)
            _, _, dist = tree.find(Vector((world.x, world.y, 0.0)))
            path_attr.data[i].value = path_wear_at_distance(
                dist, inner=inner, outer=outer, intensity=intensity
            )
    finally:
        try:
            eobj.to_mesh_clear()
        except ReferenceError:
            # Cycles' bake can invalidate the cached evaluated mesh
            # mid-operator; the per-vertex writes above already
            # happened so the bake is complete — we just can't clean
            # up the cache reference any more. Safe to swallow.
            pass
    return n_verts


def _stamp_color_0(
    terrain: bpy.types.Object,
    *,
    deep_z: float = DEFAULT_BIOME_DEEP_Z_M,
    sandy_z: float = DEFAULT_BIOME_SANDY_Z_M,
    beach_z: float = DEFAULT_BIOME_BEACH_Z_M,
) -> dict:
    """Write ``COLOR_0`` (FLOAT_COLOR, POINT) on ``terrain`` per the
    documented terrain channel contract: R reserved (0), G AO, B path-worn,
    A biome from world-Z.

    G / B sample ``baked_ao`` / ``baked_path`` if present on the mesh, so
    a follow-up ``Bake AO + Path Wear`` and re-stamp produces the same
    result as the HV_Island GN graph's live re-stamping. Without those
    attributes the defaults are G=1.0 (no occlusion), B=0.0 (pristine).

    Uses ``object.matrix_world`` for the biome lookup so the thresholds
    are interpreted in world metres regardless of the mesh's local scale
    (ANT Landscape often emits a unit-cube mesh you scale up; the
    HV_Island template's GN graph reads object-space Z on a scale-1
    mesh, which collapses to the same thing when scale = 1).

    Returns a summary dict with per-biome vert counts for the operator
    report.
    """
    from mathutils import Vector  # local import — bake.py already loads at addon register

    me = terrain.data
    mw = terrain.matrix_world

    ao_attr = me.attributes.get(BAKED_AO_ATTR)
    path_attr = me.attributes.get(BAKED_PATH_ATTR)

    if "COLOR_0" in me.color_attributes:
        me.color_attributes.remove(me.color_attributes["COLOR_0"])
    col = me.color_attributes.new(name="COLOR_0", type="FLOAT_COLOR", domain="POINT")
    # Mark it active + render so solid "Vertex" viewport shading shows
    # the stamp immediately. Without this, recreating the attribute
    # leaves active_color_index = -1 and the viewport falls back to
    # default object grey, hiding the operator's effect from the author.
    idx = me.color_attributes.find("COLOR_0")
    me.color_attributes.active_color_index = idx
    me.color_attributes.render_color_index = idx

    buckets = [0, 0, 0, 0]  # deep / sandy / beach / jungle
    for i, v in enumerate(me.vertices):
        wz = (mw @ Vector(v.co)).z
        biome = biome_from_z(wz, deep_z=deep_z, sandy_z=sandy_z, beach_z=beach_z)
        g = float(ao_attr.data[i].value) if ao_attr is not None else 1.0
        b = float(path_attr.data[i].value) if path_attr is not None else 0.0
        col.data[i].color = (0.0, g, b, biome)
        # 0, 1/3, 2/3, 1 → index 0, 1, 2, 3
        buckets[int(round(biome * 3.0))] += 1

    return {
        "vert_count": len(me.vertices),
        "biome_buckets": {
            "deep": buckets[0],
            "sandy": buckets[1],
            "beach": buckets[2],
            "jungle": buckets[3],
        },
        "had_baked_ao": ao_attr is not None,
        "had_baked_path": path_attr is not None,
    }


def _assign_terrain_material(terrain: bpy.types.Object) -> tuple[bool, str]:
    """Ensure ``mat_terrain_main`` is built and assigned to ``terrain``.

    Looks up the canonical material by name; if it doesn't exist in the
    current blend (a fresh file, or one that's never had a seed_template
    run against it), the island-palette graph from
    ``hoverbike_addon.terrain_material`` is built fresh. The seeded
    procedural templates use the same builder, so the look matches the
    in-Blender preview of `template-island.blend` regardless of how the
    terrain mesh was authored.

    Without this material the viewport falls back to raw COLOR_0 in
    solid-Vertex view (mostly green from G=AO=1) instead of the
    biome-banded preview — so the author sees a flat green island
    rather than sand / grass / rock.

    Returns ``(assigned, message)`` for the operator's report.
    """
    # Lazy import — terrain_material is part of the same addon package
    # but has no register(), so it's not in _MODULES; lazy here keeps
    # bake.py's module-load weight low.
    from . import terrain_material as _tm

    mat = _tm.ensure_mat_terrain_main()
    note_built = mat.name in bpy.data.materials and bpy.data.materials[mat.name].users == mat.users
    # We can't easily distinguish "just built" from "already present" at
    # this point — ensure_mat_terrain_main is idempotent and returns the
    # existing one if already there. Phrase the message accordingly.
    built_fresh = mat.users == 0  # newly created and not yet assigned

    me = terrain.data
    if any(m is mat for m in me.materials):
        return True, f"material {TERRAIN_MATERIAL_NAME!r} already assigned"
    if len(me.materials) == 0:
        me.materials.append(mat)
    else:
        # Replace slot 0 — the convention is one terrain material per mesh.
        me.materials[0] = mat
    verb = "built + assigned" if built_fresh else "assigned"
    return True, f"{verb} {TERRAIN_MATERIAL_NAME!r}"


# ────────────────────────────────────────────────────────────────────
# Helpers shared by the operators + the auto-bake export hook.
# ────────────────────────────────────────────────────────────────────


def _resolve_terrain() -> bpy.types.Object | None:
    """Resolve "the terrain mesh" the bakers should write into. Prefers
    a literal ``terrain`` object (every seeded template uses that name),
    then falls back to the largest visible ``kind=track`` mesh — same
    rule the road / sculpt / tunnel tools use, so hand-authored maps
    that don't start from a template still find their terrain."""
    obj = bpy.data.objects.get("terrain")
    if obj is not None and obj.type == "MESH":
        return obj
    # Lazy import: ``_legacy`` pulls in a chunk of the addon, no point
    # paying for it on every module import.
    from ._legacy import _largest_terrain_mesh

    return _largest_terrain_mesh()


def _path_wear_params(scene: bpy.types.Scene) -> tuple[float, float, float]:
    """Read the three scene-level path-wear knobs with safe defaults so
    a scene that pre-dates the props doesn't error out."""
    inner = float(
        getattr(scene, "hoverbike_path_wear_inner", DEFAULT_PATH_WEAR_INNER_M)
        or 0.0
    )
    outer = float(
        getattr(scene, "hoverbike_path_wear_outer", DEFAULT_PATH_WEAR_OUTER_M)
        or 0.0
    )
    intensity = float(
        getattr(scene, "hoverbike_path_wear_intensity", DEFAULT_PATH_WEAR_INTENSITY)
        or 0.0
    )
    return inner, outer, intensity


def auto_rebake_path_wear_on_curve_edit(scene: bpy.types.Scene) -> tuple[bool, str]:
    """Debounced auto-rebake handler — called by ``handlers.py``'s
    timer ~0.2 s after the last edit to ``ai_spline_main``.

    Mirrors the "opt-in then automatic" pattern the other live
    previews use: only re-bakes if the terrain already has a
    ``baked_path`` attribute (= the user has clicked Bake Path Wear
    at least once OR has run Apply Vertex Colors, both of which seed
    the attribute via ``_ensure_baked_attrs``). Without that gate, a
    fresh blend would start eating spline edits with hidden bakes the
    author never asked for.

    Also re-stamps ``COLOR_0`` after the path bake so the Blender
    material preview reflects the new band immediately — otherwise
    the GN graph's live attribute sampling only catches it on the
    next depsgraph update.

    Returns ``(ok, message)`` matching the export hook's convention.
    ``ok=False`` is non-fatal — the caller's just logging.
    """
    inner, outer, intensity = _path_wear_params(scene)
    if intensity <= 0.0:
        return True, "auto path-wear rebake skipped (intensity = 0)"

    terrain = _resolve_terrain()
    if terrain is None:
        return False, "auto path-wear rebake skipped: no kind=track terrain"
    # Opt-in gate: the user must have seeded baked_path at least once
    # (via Bake AO + Path Wear, Bake Path-Worn, or Apply Vertex Colors).
    # Without this, a fresh blend with an unsaved spline edit would
    # auto-bake silently — surprising and slow on big terrains.
    if BAKED_PATH_ATTR not in terrain.data.attributes:
        return True, "auto path-wear rebake skipped: terrain has no baked_path yet"

    spline = bpy.data.objects.get("ai_spline_main")
    if spline is None or spline.type != "CURVE":
        return False, "auto path-wear rebake skipped: no ai_spline_main"

    try:
        n = _bake_path_wear(
            terrain, spline, inner=inner, outer=outer, intensity=intensity
        )
    except Exception as e:  # noqa: BLE001
        return False, f"auto path-wear rebake failed: {e}"

    # Re-stamp COLOR_0 so the Blender material preview picks up the
    # new B values. The procedural-template GN graph re-samples
    # baked_path live, so for those terrains this is redundant; for
    # hand-rolled (ANT / heightmap / sculpt) terrains it's required
    # because COLOR_0 is static data, not a live sample.
    try:
        _stamp_color_0(terrain)
    except Exception as e:  # noqa: BLE001
        # Bake succeeded so the GLB export will still ship correctly.
        return False, f"auto path-wear rebake stamped baked_path but COLOR_0 re-stamp failed: {e}"

    return True, f"auto-rebaked path-wear over {n} vertices"


def auto_bake_path_wear_for_export(scene: bpy.types.Scene) -> tuple[bool, str]:
    """Pre-export hook: stamp ``baked_path`` from the current scene
    settings before the GLB is written, so authors who never thought
    about path-wear still ship with a baked racing line.

    Returns ``(ok, message)``. ``ok=False`` is non-fatal — the caller
    logs it as a warning and continues the export. Skipped if the
    scene has no ``ai_spline_main`` (a brand-new map mid-authoring),
    no terrain, or if every path-wear input is at its skip-it default
    (``intensity == 0``).
    """
    inner, outer, intensity = _path_wear_params(scene)
    if intensity <= 0.0:
        return True, "path-wear bake skipped (intensity = 0)"

    terrain = _resolve_terrain()
    if terrain is None:
        return False, "path-wear bake skipped: no kind=track terrain"
    spline = bpy.data.objects.get("ai_spline_main")
    if spline is None or spline.type != "CURVE":
        return False, "path-wear bake skipped: no ai_spline_main"

    _ensure_baked_attrs(terrain)
    try:
        n = _bake_path_wear(
            terrain, spline, inner=inner, outer=outer, intensity=intensity
        )
    except Exception as e:  # noqa: BLE001
        return False, f"path-wear bake failed: {e}"
    return True, f"path-wear baked over {n} vertices"


# ────────────────────────────────────────────────────────────────────
# Operators
# ────────────────────────────────────────────────────────────────────


class HOVERBIKE_OT_bake_terrain_attrs(Operator):
    """Bake AO + racing-line wear into the source terrain's
    ``baked_ao`` / ``baked_path`` attributes. The HV_Island GN graph
    samples both via Named Attribute nodes and routes them into
    COLOR_0.G (AO multiplier) and COLOR_0.B (path-worn), which the
    runtime terrain shader reads to darken cavities and stamp a worn
    dirt line into the racing surface."""

    bl_idname = "hoverbike.bake_terrain_attrs"
    bl_label = "Bake AO + Path Wear"
    bl_description = (
        "Bake ambient occlusion (Cycles) and AI-spline path wear (Python KDTree) "
        "into the terrain's baked_ao + baked_path attributes. ~10-20 s on a 150k-vert terrain."
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        terrain = _resolve_terrain()
        if terrain is None:
            self.report({"ERROR"}, "no `kind=track` terrain mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        inner, outer, intensity = _path_wear_params(context.scene)
        _ensure_baked_attrs(terrain)
        try:
            _bake_ao_cycles(terrain)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"AO bake failed: {e}")
            return {"CANCELLED"}
        try:
            n = _bake_path_wear(
                terrain, spline, inner=inner, outer=outer, intensity=intensity
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"Baked AO + path wear over {n} vertices")
        return {"FINISHED"}


class HOVERBIKE_OT_bake_path_worn(Operator):
    """Bake just the racing-line wear mask — fast path for iterating on
    falloff width / intensity without paying the Cycles AO cost. Writes
    the same ``baked_path`` FLOAT attribute the AO+path operator writes
    into, so the GN graph still picks it up into ``COLOR_0.B``.

    The bake reads the *evaluated* terrain (post-GN modifiers) so any
    procedural displacement is reflected in the per-vertex world XZ
    distance to the AI spline. The wear value follows a smoothstep:
    full wear (= 1 × intensity) within ``Falloff inner`` of the line,
    no wear beyond ``Falloff outer``. Defaults match the racing-line
    feel — full wear directly on the line, faded out beyond 8 m.

    Idempotent: same inputs → same stamps. Pure producer for the
    runtime ``pathTint`` mix in ``src/engine/render/terrain-shader.ts``;
    requires the seeded GN graph (or an equivalent one) that samples
    ``baked_path`` into ``COLOR_0.B``."""

    bl_idname = "hoverbike.bake_path_worn"
    bl_label = "Bake Path-Worn"
    bl_description = (
        "Stamp the racing-line wear mask (distance-to-spline, smoothstep falloff) "
        "into the terrain's baked_path attribute. ~1 s on a 150k-vert terrain"
    )
    bl_options = {"REGISTER", "UNDO"}

    # Operator-level overrides so the F6 Redo panel exposes the same
    # three knobs as the sub-panel. Default to the scene props so a
    # click on the sub-panel button uses the author's tuning verbatim.
    inner_m: FloatProperty(  # type: ignore[valid-type]
        name="Falloff inner (m)",
        description=(
            "Distance from the AI spline at which wear saturates at 1.0. "
            "Default 0 m — full wear on the racing line itself"
        ),
        default=DEFAULT_PATH_WEAR_INNER_M, min=0.0, max=50.0, precision=2,
    )
    outer_m: FloatProperty(  # type: ignore[valid-type]
        name="Falloff outer (m)",
        description=(
            "Distance beyond which wear is 0. Smoothstep falloff between inner "
            "and outer. Default 8 m"
        ),
        default=DEFAULT_PATH_WEAR_OUTER_M, min=0.1, max=200.0, precision=2,
    )
    intensity: FloatProperty(  # type: ignore[valid-type]
        name="Intensity",
        description=(
            "Multiplier on the final wear value (clamped to [0, 1]). 0 disables "
            "the bake entirely so the GLB ships pristine; 1 stamps the full mask"
        ),
        default=DEFAULT_PATH_WEAR_INTENSITY, min=0.0, max=1.0, precision=2,
    )
    use_scene: BoolProperty(  # type: ignore[valid-type]
        name="Use scene knobs",
        description=(
            "If on (default), pull falloff inner/outer/intensity from the "
            "scene-level path-wear sliders. Off lets you A/B test values in "
            "the F6 Redo panel without disturbing the scene tuning"
        ),
        default=True,
    )

    def execute(self, context):
        terrain = _resolve_terrain()
        if terrain is None:
            self.report({"ERROR"}, "no `kind=track` terrain mesh in scene")
            return {"CANCELLED"}
        spline = bpy.data.objects.get("ai_spline_main")
        if spline is None or spline.type != "CURVE":
            self.report({"ERROR"}, "no `ai_spline_main` curve in scene")
            return {"CANCELLED"}

        if self.use_scene:
            inner, outer, intensity = _path_wear_params(context.scene)
        else:
            inner, outer, intensity = (
                float(self.inner_m),
                float(self.outer_m),
                float(self.intensity),
            )

        _ensure_baked_attrs(terrain)
        try:
            n = _bake_path_wear(
                terrain, spline, inner=inner, outer=outer, intensity=intensity
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"path-wear bake failed: {e}")
            return {"CANCELLED"}
        self.report(
            {"INFO"},
            f"Baked path wear over {n} vertices "
            f"(inner={inner:.1f} m, outer={outer:.1f} m, intensity={intensity:.2f})",
        )
        return {"FINISHED"}


class HOVERBIKE_OT_apply_terrain_vertex_colors(Operator):
    """Stamp ``COLOR_0`` on a hand-rolled terrain mesh (ANT Landscape
    output, heightmap import, sculpted plane — anything without an
    HV_Island-style GN graph doing the stamping for it).

    Writes the documented terrain channel contract per-vertex: R=0
    (reserved), G=baked_ao or 1.0, B=baked_path or 0.0, A=biome from
    world-Z via the same three-threshold formula as the templates.
    Targets the active mesh if one is selected, otherwise falls back to
    the largest visible kind=track mesh. Tags the target ``kind="track"``
    if missing so the export and runtime pick it up as a collidable
    surface."""

    bl_idname = "hoverbike.apply_terrain_vertex_colors"
    bl_label = "Apply Vertex Colors"
    bl_description = (
        "Stamp COLOR_0 on the active terrain mesh from world-Z biome + "
        "baked_ao + baked_path. Use this for ANT Landscape / heightmap / "
        "sculpted meshes that don't carry an HV_Island GN graph"
    )
    bl_options = {"REGISTER", "UNDO"}

    deep_z: FloatProperty(  # type: ignore[valid-type]
        name="Deep < Z (m)",
        description=(
            "World-Z below this is the deep biome (COLOR_0.A = 0). "
            "Defaults to -22 m to match seed_template_island"
        ),
        default=DEFAULT_BIOME_DEEP_Z_M, min=-500.0, max=500.0, precision=2,
    )
    sandy_z: FloatProperty(  # type: ignore[valid-type]
        name="Sandy < Z (m)",
        description=(
            "World-Z between deep_z and this is the sandy/shallow biome "
            "(COLOR_0.A = 1/3). Defaults to 0 m (waterline)"
        ),
        default=DEFAULT_BIOME_SANDY_Z_M, min=-500.0, max=500.0, precision=2,
    )
    beach_z: FloatProperty(  # type: ignore[valid-type]
        name="Beach < Z (m)",
        description=(
            "World-Z between sandy_z and this is the beach biome "
            "(COLOR_0.A = 2/3); above this is jungle (1.0). Defaults to 4 m"
        ),
        default=DEFAULT_BIOME_BEACH_Z_M, min=-500.0, max=500.0, precision=2,
    )
    tag_as_track: BoolProperty(  # type: ignore[valid-type]
        name="Tag as kind=track",
        description=(
            "Add the kind=track custom property if missing, so the GLB "
            "exporter ships the mesh as a collidable surface"
        ),
        default=True,
    )
    assign_material: BoolProperty(  # type: ignore[valid-type]
        name="Assign mat_terrain_main",
        description=(
            "Also assign the canonical mat_terrain_main material if it's "
            "in the scene. Without it, the viewport's material preview "
            "shows raw COLOR_0 (green-dominant) instead of the biome "
            "bands the procedural templates produce"
        ),
        default=True,
    )

    def execute(self, context):
        # Prefer the active selection if it's a mesh — lets the user point
        # the operator at a freshly-added ANT Landscape mesh that hasn't
        # been recognised by ``_resolve_terrain`` yet (e.g. no kind tag).
        ao = context.active_object
        if ao is not None and ao.type == "MESH":
            terrain = ao
        else:
            terrain = _resolve_terrain()
        if terrain is None:
            self.report({"ERROR"}, "no terrain mesh selected and no kind=track mesh in scene")
            return {"CANCELLED"}

        # Thresholds must be monotonic — silently clamp rather than refuse
        # so the F6 Redo panel stays interactive while the user drags.
        deep_z = float(self.deep_z)
        sandy_z = max(float(self.sandy_z), deep_z)
        beach_z = max(float(self.beach_z), sandy_z)

        tagged_now = False
        if self.tag_as_track and terrain.get("kind") != "track":
            terrain["kind"] = "track"
            tagged_now = True

        _ensure_baked_attrs(terrain)
        try:
            summary = _stamp_color_0(
                terrain, deep_z=deep_z, sandy_z=sandy_z, beach_z=beach_z
            )
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"COLOR_0 stamp failed: {e}")
            return {"CANCELLED"}

        material_note = ""
        if self.assign_material:
            try:
                _assigned, msg = _assign_terrain_material(terrain)
                material_note = f" [{msg}]"
            except Exception as e:  # noqa: BLE001
                # Material build failure is non-fatal — the COLOR_0 stamp
                # itself succeeded so the GLB export will carry the right
                # data. WARN so the author can fix it (or assign a material
                # manually) without losing the bake work.
                material_note = f" [material build failed: {e}]"
                self.report({"WARNING"}, f"terrain material build failed: {e}")

        b = summary["biome_buckets"]
        bake_note = (
            "baked_ao + baked_path"
            if summary["had_baked_ao"] and summary["had_baked_path"]
            else "defaults (run Bake AO + Path Wear for real values)"
        )
        tag_note = " [tagged kind=track]" if tagged_now else ""
        self.report(
            {"INFO"},
            f"Stamped COLOR_0 on {terrain.name!r} over {summary['vert_count']} verts "
            f"(deep {b['deep']} / sandy {b['sandy']} / beach {b['beach']} / "
            f"jungle {b['jungle']}, G+B from {bake_note}){tag_note}{material_note}",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Self-test — exercised by `pnpm test:blender` and the python -m run
# at the bottom of the file. Lives next to the math it tests so a
# missed edge case fails loud the moment someone reloads the addon.
# ────────────────────────────────────────────────────────────────────


def _self_test() -> None:
    # Pass explicit (inner, outer) to every assertion so the test stays
    # independent of the module-level DEFAULT_PATH_WEAR_OUTER_M value
    # (which has been tuned up from 8 → 20 m to suit typical heightmap
    # density). Hard-coding the assumption that defaults are (0, 8, 1)
    # caused a test break the last time the default was retuned.
    eps = 1e-9
    assert abs(path_wear_at_distance(0.0, inner=0.0, outer=8.0) - 1.0) < eps, "vertex on line → 1"
    assert abs(path_wear_at_distance(8.0, inner=0.0, outer=8.0) - 0.0) < eps, "vertex at outer → 0"
    assert abs(path_wear_at_distance(9.0, inner=0.0, outer=8.0) - 0.0) < eps, "vertex past outer → 0"
    # Midpoint: 4 m of an 8 m band → smoothstep(0.5) = 0.5.
    mid = path_wear_at_distance(4.0, inner=0.0, outer=8.0)
    assert abs(mid - 0.5) < 1e-6, f"midpoint should be ~0.5, got {mid}"

    # Inner band: anything within 0 m saturates; pick a non-zero inner to
    # show the saturation plateau.
    assert path_wear_at_distance(0.5, inner=1.0, outer=5.0) == 1.0
    assert path_wear_at_distance(1.0, inner=1.0, outer=5.0) == 1.0

    # Intensity scales the output linearly.
    assert abs(path_wear_at_distance(0.0, inner=0.0, outer=8.0, intensity=0.4) - 0.4) < eps
    assert abs(path_wear_at_distance(4.0, inner=0.0, outer=8.0, intensity=0.5) - 0.25) < 1e-6

    # Intensity = 0 → always 0 (used by the export hook to short-circuit).
    assert path_wear_at_distance(0.0, inner=0.0, outer=8.0, intensity=0.0) == 0.0

    # Degenerate band (outer <= inner) collapses to a hard mask at inner.
    assert path_wear_at_distance(2.0, inner=5.0, outer=5.0) == 1.0
    assert path_wear_at_distance(6.0, inner=5.0, outer=5.0) == 0.0

    # Intensity gets clamped to [0, 1] so a runaway slider can't write
    # values past 1 into COLOR_0.B.
    assert path_wear_at_distance(0.0, inner=0.0, outer=8.0, intensity=2.0) == 1.0
    assert path_wear_at_distance(0.0, inner=0.0, outer=8.0, intensity=-1.0) == 0.0

    # Monotone in distance over the falloff band.
    last = float("inf")
    for d_int in range(0, 81):
        d = d_int / 10.0  # 0.0 → 8.0 in 0.1 steps
        w = path_wear_at_distance(d, inner=0.0, outer=8.0)
        assert w <= last + 1e-9, f"wear should be monotone decreasing, {w} > {last}"
        last = w

    # biome_from_z — defaults (-22 / 0 / 4) match the template thresholds.
    assert biome_from_z(-100.0) == 0.0,                "deep abyss → 0"
    assert biome_from_z(-22.0) == 0.0,                 "= deep_z → still 0 (strict >)"
    assert abs(biome_from_z(-21.0) - 1 / 3) < 1e-9,    "above deep → 1/3"
    assert abs(biome_from_z(-0.5) - 1 / 3) < 1e-9,     "shallow → 1/3"
    assert abs(biome_from_z(0.5) - 2 / 3) < 1e-9,      "beach → 2/3"
    assert abs(biome_from_z(3.5) - 2 / 3) < 1e-9,      "high beach → 2/3"
    assert biome_from_z(4.5) == 1.0,                   "jungle → 1"
    assert biome_from_z(100.0) == 1.0,                 "alpine → still 1"
    # Custom thresholds — verify the per-band lookups land where expected.
    assert biome_from_z(5.0, deep_z=0.0, sandy_z=10.0, beach_z=20.0) == 1 / 3
    assert biome_from_z(15.0, deep_z=0.0, sandy_z=10.0, beach_z=20.0) == 2 / 3
    assert biome_from_z(25.0, deep_z=0.0, sandy_z=10.0, beach_z=20.0) == 1.0

    # _densify_polyline_xy — confirm the gap-fill maths produces a
    # polyline whose adjacent samples are within max_step_m in XY.
    class _P:
        def __init__(self, x, y, z=0.0):
            self.x, self.y, self.z = x, y, z
        def lerp(self, other, t):
            return _P(self.x + (other.x - self.x) * t,
                     self.y + (other.y - self.y) * t,
                     self.z + (other.z - self.z) * t)

    raw = [_P(0, 0, 0), _P(10, 0, 0), _P(10, 5, 0)]
    dense = _densify_polyline_xy(raw, max_step_m=1.0)
    # 10 m segment + 5 m segment → at least 15 sub-segments + 3 originals.
    assert len(dense) >= 16, f"densified polyline too short: {len(dense)}"
    # Verify no XY gap exceeds 1.01 m (allow tiny FP slop).
    for a, b in zip(dense, dense[1:]):
        gap = ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5
        assert gap <= 1.01, f"densified polyline has gap {gap:.3f} m > 1.0"
    # Pass-through cases.
    assert _densify_polyline_xy([], max_step_m=1.0) == []
    assert len(_densify_polyline_xy([_P(0, 0)], max_step_m=1.0)) == 1

    print("ALL PYTHON CHECKS PASS")


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_bake_terrain_attrs,
    HOVERBIKE_OT_bake_path_worn,
    HOVERBIKE_OT_apply_terrain_vertex_colors,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)

    bpy.types.Scene.hoverbike_path_wear_inner = FloatProperty(
        name="Path-wear inner (m)",
        description=(
            "Distance from the AI spline at which wear saturates at 1.0. "
            "0 = full wear directly on the racing line"
        ),
        default=DEFAULT_PATH_WEAR_INNER_M, min=0.0, max=50.0, precision=2,
    )
    bpy.types.Scene.hoverbike_path_wear_outer = FloatProperty(
        name="Path-wear outer (m)",
        description=(
            "Distance beyond which wear fades to 0. Smoothstep falloff between "
            "inner and outer"
        ),
        default=DEFAULT_PATH_WEAR_OUTER_M, min=0.1, max=200.0, precision=2,
    )
    bpy.types.Scene.hoverbike_path_wear_intensity = FloatProperty(
        name="Path-wear intensity",
        description=(
            "Multiplier on the final wear stamp. 0 disables the bake (handy "
            "for tracks whose biome shouldn't show a worn line, e.g. tunnel "
            "interiors or anti-grav stretches); 1 stamps the full mask"
        ),
        default=DEFAULT_PATH_WEAR_INTENSITY, min=0.0, max=1.0, precision=2,
    )


def unregister() -> None:
    for prop in (
        "hoverbike_path_wear_inner",
        "hoverbike_path_wear_outer",
        "hoverbike_path_wear_intensity",
    ):
        try:
            delattr(bpy.types.Scene, prop)
        except AttributeError:
            pass
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass


# Run the self-test when invoked as a script (the existing
# tools/blender pattern — see gate_placement.py for a sibling).
if __name__ == "__main__":
    _self_test()
