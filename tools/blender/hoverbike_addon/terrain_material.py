"""Author-preview terrain material — the canonical ``mat_terrain_main``.

Each ``seed_template_*.py`` script builds a ``mat_terrain_main`` tailored
to its track style (alpine has snow caps, dunes is pure sand, downtown
is concrete). This module owns the *island* variant — the most general
palette (abyssal blue → sand → grass → forest → alpine stone → volcanic
peak) suitable for any hand-rolled / ANT Landscape / heightmap terrain
where the author hasn't yet committed to a biome theme.

It's used by two callers:

* ``hoverbike.apply_terrain_vertex_colors`` (the addon operator) — builds
  ``mat_terrain_main`` on demand if the scene doesn't already have one,
  so the viewport's material preview decodes COLOR_0 into biome bands
  instead of showing the raw green-dominant vertex colour.
* ``tools/blender/seed_template_island.py`` — delegates here from its
  ``build_terrain_material`` so the seed script and the addon stay in
  lock-step (no drift between the two copies).

The material is **author-only**: the runtime ships its own terrain
shader (``src/engine/render/terrain-shader.ts``) that reads ``COLOR_0``
from the exported .glb. The Blender material only needs to look
plausible while authoring.
"""

from __future__ import annotations

import bpy
from bpy.props import BoolProperty
from bpy.types import Operator


MATERIAL_NAME = "mat_terrain_main"


def build_island_material_nodes(mat: bpy.types.Material) -> None:
    """Fill ``mat``'s node tree with the island-palette terrain graph.

    Pure builder — caller owns the Material object and decides where to
    assign it. ``mat.use_nodes`` must be True; any existing nodes are
    wiped first so this is safe to call on an already-populated graph
    (e.g. when rebuilding after a tweak).

    Graph shape (≈19 nodes):

      * COLOR_0 attribute → BSDF emission (weight 0) — keeps the glTF
        exporter's "does this material use vertex colour?" heuristic
        engaged so the GN-stamped attribute ships in the .glb.
      * Slope mask: normal.z smoothstep'd between cos(30°) and cos(55°)
        so gentle slopes still read as grass / sand, only true cliffs
        get the rock ramp.
      * Two altitude ColorRamps (flat = sand/grass/forest, cliff = wet
        rock / cliff stone / volcanic), mixed by the slope mask.
      * 3D noise breaks ramp banding via signed brightness offset.
      * Wet-band darken: triangular |z| mask peaking at z=0 multiplies
        a cool tint over damp sand / wave-washed rock.
      * Roughness rises on slopes (sand ≈ 0.78 → rock ≈ 0.95).

    Altitude ramp is calibrated for z ∈ [-50, 120] m. Tracks with peaks
    past 120 m just clamp the ramp's top stop, which is fine — the
    palette tops out at volcanic dark anyway.
    """
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)

    def add(kind, x, y, **kw):
        n = nt.nodes.new(kind)
        n.location = (x, y)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    n_out = add("ShaderNodeOutputMaterial", 1800, 0)
    n_bsdf = add("ShaderNodeBsdfPrincipled", 1500, 0)

    # An Attribute node reading COLOR_0 — connected through to BSDF
    # Emission so the Blender glTF exporter's heuristic ("does this
    # material reference any vertex-colour attribute?") returns true
    # and the GN-stamped COLOR_0 actually ships in the .glb. The
    # emission weight is zero so it doesn't affect the Eevee preview.
    n_color0 = add("ShaderNodeAttribute", -1600, 500)
    n_color0.attribute_name = "COLOR_0"
    nt.links.new(n_color0.outputs["Color"], n_bsdf.inputs["Emission Color"])
    n_bsdf.inputs["Emission Strength"].default_value = 0.0

    # --- inputs: position + normal ------------------------------------
    n_geom = add("ShaderNodeNewGeometry", -1600, 200)
    n_pos_xyz = add("ShaderNodeSeparateXYZ", -1400, 300)
    nt.links.new(n_geom.outputs["Position"], n_pos_xyz.inputs["Vector"])
    n_nrm_xyz = add("ShaderNodeSeparateXYZ", -1400, 0)
    nt.links.new(n_geom.outputs["Normal"], n_nrm_xyz.inputs["Vector"])

    # --- slope mask: 0 on flat tops, 1 on cliffs ----------------------
    # Normal.z drops from 1 (flat) to 0 (vertical). Smoothstep between
    # ~30° (cos ≈ 0.85) and ~55° (cos ≈ 0.57) so gentle slopes still
    # read as grass / sand.
    n_slope_mr = add(
        "ShaderNodeMapRange", -1200, 0,
        interpolation_type="SMOOTHSTEP", clamp=True,
    )
    n_slope_mr.inputs["From Min"].default_value = 0.85
    n_slope_mr.inputs["From Max"].default_value = 0.55
    n_slope_mr.inputs["To Min"].default_value = 0.0
    n_slope_mr.inputs["To Max"].default_value = 1.0
    nt.links.new(n_nrm_xyz.outputs["Z"], n_slope_mr.inputs["Value"])

    # --- altitude -> [0, 1] fac for the ramps -------------------------
    # Map z ∈ [-50, 120] → [0, 1]. The flat / cliff ramps are tuned to
    # this range; if peaks ever exceed 120 m, ramp tops just clamp.
    n_alt_mr = add("ShaderNodeMapRange", -1200, 300, clamp=True)
    n_alt_mr.inputs["From Min"].default_value = -50.0
    n_alt_mr.inputs["From Max"].default_value = 120.0
    n_alt_mr.inputs["To Min"].default_value = 0.0
    n_alt_mr.inputs["To Max"].default_value = 1.0
    nt.links.new(n_pos_xyz.outputs["Z"], n_alt_mr.inputs["Value"])

    def _ramp(x, y, stops):
        r = add("ShaderNodeValToRGB", x, y)
        cr = r.color_ramp
        cr.interpolation = "LINEAR"
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[1])
        cr.elements[0].position = stops[0][0]
        cr.elements[0].color = stops[0][1]
        for pos, col in stops[1:]:
            e = cr.elements.new(pos)
            e.color = col
        return r

    # --- flat ramp: deep blue → sandy → wet beach → grass → forest → bare ---
    n_flat_ramp = _ramp(-800, 400, [
        (0.000, (0.03, 0.08, 0.20, 1.0)),   # abyssal blue   (z≈-50)
        (0.180, (0.22, 0.30, 0.40, 1.0)),   # blue-sand      (z≈-19)
        (0.270, (0.68, 0.66, 0.55, 1.0)),   # silty sand     (z≈-4)
        (0.300, (0.92, 0.86, 0.72, 1.0)),   # bright sand    (z= 1)
        (0.345, (0.78, 0.70, 0.50, 1.0)),   # wet beach tan  (z= 9)
        (0.430, (0.36, 0.55, 0.27, 1.0)),   # grass          (z=23)
        (0.620, (0.22, 0.40, 0.18, 1.0)),   # forest         (z=55)
        (0.820, (0.30, 0.27, 0.21, 1.0)),   # alpine stone   (z=89)
        (1.000, (0.18, 0.15, 0.13, 1.0)),   # volcanic top   (z=120)
    ])
    nt.links.new(n_alt_mr.outputs["Result"], n_flat_ramp.inputs["Fac"])

    # --- cliff ramp: cool deep → wet rock → cliff stone → volcanic ---
    n_cliff_ramp = _ramp(-800, 100, [
        (0.000, (0.07, 0.10, 0.16, 1.0)),   # dark abyssal rock
        (0.220, (0.20, 0.22, 0.24, 1.0)),   # wet rock
        (0.300, (0.34, 0.32, 0.28, 1.0)),   # sea cliff
        (0.500, (0.42, 0.39, 0.34, 1.0)),   # grey rock
        (0.750, (0.30, 0.25, 0.22, 1.0)),   # warmer rock
        (1.000, (0.16, 0.13, 0.13, 1.0)),   # volcanic
    ])
    nt.links.new(n_alt_mr.outputs["Result"], n_cliff_ramp.inputs["Fac"])

    # --- mix flat + cliff by slope ------------------------------------
    n_mix_slope = add("ShaderNodeMix", -400, 250, data_type="RGBA")
    n_mix_slope.blend_type = "MIX"
    n_mix_slope.clamp_factor = True
    nt.links.new(n_slope_mr.outputs["Result"], n_mix_slope.inputs[0])
    nt.links.new(n_flat_ramp.outputs["Color"],  n_mix_slope.inputs[6])
    nt.links.new(n_cliff_ramp.outputs["Color"], n_mix_slope.inputs[7])

    # --- variation noise: breaks ramp banding via Brightness/Contrast ---
    # Two-octave noise drives a signed brightness offset (±0.10) so neither
    # sand nor grass reads as a flat fill. Using Brightness/Contrast avoids
    # ColorRamp's 0..1 colour clamping, which would otherwise lose the
    # "brighten" half of the variation.
    n_var_noise = add("ShaderNodeTexNoise", -1200, -300)
    n_var_noise.noise_dimensions = "3D"
    n_var_noise.normalize = True
    n_var_noise.inputs["Scale"].default_value = 1.2
    n_var_noise.inputs["Detail"].default_value = 6.0
    n_var_noise.inputs["Roughness"].default_value = 0.55
    nt.links.new(n_geom.outputs["Position"], n_var_noise.inputs["Vector"])
    n_var_signed = add("ShaderNodeMapRange", -900, -300, clamp=True)
    n_var_signed.inputs["From Min"].default_value = 0.0
    n_var_signed.inputs["From Max"].default_value = 1.0
    n_var_signed.inputs["To Min"].default_value = -0.10
    n_var_signed.inputs["To Max"].default_value = 0.10
    nt.links.new(n_var_noise.outputs["Fac"], n_var_signed.inputs["Value"])
    n_color_var = add("ShaderNodeBrightContrast", -200, -100)
    nt.links.new(n_mix_slope.outputs[2],            n_color_var.inputs["Color"])
    nt.links.new(n_var_signed.outputs["Result"],    n_color_var.inputs["Bright"])

    # --- wet-band darken near waterline -------------------------------
    # Triangular |z|-mask: peaks at z=0 (shoreline) and falls to 0 at
    # |z|≥2. Pulls saturation down on damp sand / wave-washed rock
    # without bleeding into the abyssal floor (~-25 m).
    n_wet_abs = add("ShaderNodeMath", -1400, -600, operation="ABSOLUTE")
    nt.links.new(n_pos_xyz.outputs["Z"], n_wet_abs.inputs[0])
    n_wet_mr = add(
        "ShaderNodeMapRange", -1200, -600,
        interpolation_type="SMOOTHSTEP", clamp=True,
    )
    n_wet_mr.inputs["From Min"].default_value = 0.0
    n_wet_mr.inputs["From Max"].default_value = 2.0
    n_wet_mr.inputs["To Min"].default_value = 1.0
    n_wet_mr.inputs["To Max"].default_value = 0.0
    nt.links.new(n_wet_abs.outputs[0], n_wet_mr.inputs["Value"])
    n_wet_tint = add("ShaderNodeRGB", -900, -600)
    n_wet_tint.outputs[0].default_value = (0.78, 0.78, 0.82, 1.0)
    n_wet_mix = add("ShaderNodeMix", 100, -300, data_type="RGBA")
    n_wet_mix.blend_type = "MULTIPLY"
    n_wet_mix.clamp_factor = True
    nt.links.new(n_wet_mr.outputs["Result"], n_wet_mix.inputs[0])
    nt.links.new(n_color_var.outputs["Color"], n_wet_mix.inputs[6])
    nt.links.new(n_wet_tint.outputs[0],  n_wet_mix.inputs[7])

    nt.links.new(n_wet_mix.outputs[2], n_bsdf.inputs["Base Color"])

    # --- roughness: rocks rougher than sand / grass --------------------
    n_rough_mr = add("ShaderNodeMapRange", 300, -100, clamp=True)
    n_rough_mr.inputs["From Min"].default_value = 0.0
    n_rough_mr.inputs["From Max"].default_value = 1.0
    n_rough_mr.inputs["To Min"].default_value = 0.78
    n_rough_mr.inputs["To Max"].default_value = 0.95
    nt.links.new(n_slope_mr.outputs["Result"], n_rough_mr.inputs["Value"])
    nt.links.new(n_rough_mr.outputs["Result"], n_bsdf.inputs["Roughness"])

    n_bsdf.inputs["Metallic"].default_value = 0.0
    nt.links.new(n_bsdf.outputs["BSDF"], n_out.inputs["Surface"])


def ensure_mat_terrain_main(*, rebuild: bool = False) -> bpy.types.Material:
    """Return ``mat_terrain_main`` from the current blend, building the
    island-palette graph into it if missing.

    Args:
        rebuild: if True, wipe and rebuild even when the material already
            exists. Useful when tweaking the palette and wanting to
            re-render with the new graph. Default False so repeat calls
            from the operator are cheap no-ops once the material exists.

    Returns the Material datablock. Caller assigns it to whatever mesh.
    """
    mat = bpy.data.materials.get(MATERIAL_NAME)
    if mat is not None and not rebuild:
        return mat
    if mat is None:
        mat = bpy.data.materials.new(MATERIAL_NAME)
        mat.use_nodes = True
    elif not mat.use_nodes:
        mat.use_nodes = True
    build_island_material_nodes(mat)
    return mat


# ────────────────────────────────────────────────────────────────────
# Operator
# ────────────────────────────────────────────────────────────────────


def _resolve_target_mesh(context) -> bpy.types.Object | None:
    """Pick the mesh the material operator should act on. Prefers the
    active selection if it's a MESH so authors can target any terrain
    object directly; falls back to the canonical ``terrain`` mesh by
    name (matches the convention every seed_template_*.py follows)."""
    ao = context.active_object
    if ao is not None and ao.type == "MESH":
        return ao
    obj = bpy.data.objects.get("terrain")
    if obj is not None and obj.type == "MESH":
        return obj
    return None


class HOVERBIKE_OT_add_terrain_material(Operator):
    """Build (if missing) the canonical ``mat_terrain_main`` and assign
    it to the active mesh.

    Pure material-side operator — doesn't touch vertex attributes, doesn't
    tag ``kind="track"``. Use this when you want the biome-banded
    viewport preview on a terrain whose COLOR_0 already exists (e.g. a
    procedural HV_Island terrain, an imported heightmap, or a mesh
    that ran ``apply_terrain_vertex_colors`` previously and just lost
    its material slot)."""

    bl_idname = "hoverbike.add_terrain_material"
    bl_label = "Add Terrain Material"
    bl_description = (
        "Build mat_terrain_main (island palette: sand / grass / forest / rock) "
        "if missing and assign it to the active mesh. Material-only — does not "
        "stamp COLOR_0 or tag kind=track"
    )
    bl_options = {"REGISTER", "UNDO"}

    rebuild: BoolProperty(  # type: ignore[valid-type]
        name="Rebuild material node graph",
        description=(
            "Wipe and rebuild the node graph even if mat_terrain_main "
            "already exists. Useful after tweaking the palette in source "
            "to pick up the new stops without restarting Blender"
        ),
        default=False,
    )

    def execute(self, context):
        target = _resolve_target_mesh(context)
        if target is None:
            self.report({"ERROR"}, "no mesh selected (and no fallback 'terrain' mesh in scene)")
            return {"CANCELLED"}

        # Snapshot whether the material existed before the ensure call so
        # the INFO report can distinguish built / rebuilt / reused without
        # a second lookup.
        existed_before = MATERIAL_NAME in bpy.data.materials
        try:
            mat = ensure_mat_terrain_main(rebuild=self.rebuild)
        except Exception as e:  # noqa: BLE001
            self.report({"ERROR"}, f"terrain material build failed: {e}")
            return {"CANCELLED"}

        me = target.data
        already = any(m is mat for m in me.materials)
        if not already:
            if len(me.materials) == 0:
                me.materials.append(mat)
            else:
                # Replace slot 0 — convention is one terrain material per mesh.
                me.materials[0] = mat

        if not existed_before:
            verb_mat = "built"
        elif self.rebuild:
            verb_mat = "rebuilt"
        else:
            verb_mat = "reused existing"
        verb_slot = "kept" if already else ("appended to" if len(me.materials) == 1 else "swapped into slot 0 of")
        self.report(
            {"INFO"},
            f"{verb_mat} {MATERIAL_NAME!r}, {verb_slot} {target.name!r}",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────


_CLASSES: tuple[type, ...] = (
    HOVERBIKE_OT_add_terrain_material,
)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
