"""New Map from Template — duplicate a ``tracks-src/template-*.blend``
to a fresh ``tracks-src/<id>.blend`` and open it.

The repo already ships seven scaffolding ``.blend``s (island, mesa,
alpine, dunes, tunnels, tunnel-island, downtown). Authors who want to
start a new map have to know they exist, find them in the file
browser, and remember the "open, save-as into ``tracks-src/``" rope-
trick. This module promotes that workflow to a one-click operator
with a dialog, surfaced in the addon panel.

Behaviour:

  1. Enumerate every ``tracks-src/template-*.blend`` under the repo
     root (resolved from the currently-open .blend, since the addon
     has no other repo-locating signal).
  2. Show a properties dialog: pick a template, type a new track id
     (lowercase letters / digits / dashes — same rules as the export
     operator's id validator).
  3. Copy the template file to ``tracks-src/<id>.blend`` and open it.
     The addon's load handler then picks up "track mode" automatically
     (parent dir = ``tracks-src``) and the sidebar switches to the
     authoring tools.

Why a copy (not a symlink / link / library): Blender saves overwrite
the file, and we want the user's edits to land in the new file
without ever touching the template. A plain copy is the cheapest
isolation guarantee.
"""

from __future__ import annotations

import os
import re
import shutil

import bpy
from bpy.props import EnumProperty, StringProperty
from bpy.types import Operator


TEMPLATE_GLOB_PREFIX = "template-"
TEMPLATE_DIR = "tracks-src"
TRACK_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")

# One-line descriptions surfaced in the dialog so authors aren't picking
# a template blind. Keep these short — they show up next to the name in
# the EnumProperty dropdown.
TEMPLATE_BLURBS = {
    "template-island":         "Procedural island. Generic open-water loop.",
    "template-mesa":           "Cliff-edge mesa with drop. Good for jumps.",
    "template-alpine":         "Mountain pass with elevation change.",
    "template-dunes":          "Desert dunes / soft rolling terrain.",
    "template-tunnels":        "Mountainous terrain pre-rigged for tunnels.",
    "template-tunnel-island":  "Island + three tunnels, AI-completable lap.",
    "template-downtown":       "City-block grid with surrounding terrain.",
}


def _find_repo_root() -> str | None:
    """Resolve the repo root via the currently-open .blend. Returns
    None if there is no .blend open or the .blend isn't inside a
    hoverbike clone — the operator surfaces a clear error in that case
    so the author knows to save / open a .blend in the repo first."""
    from ._legacy import find_repo_root

    blend = bpy.data.filepath
    if not blend:
        return None
    return find_repo_root(blend)


def _list_templates(repo: str) -> list[str]:
    """Names (without ``.blend``) of every ``template-*.blend`` in the
    repo's ``tracks-src/`` directory. Sorted alphabetically so the
    dialog dropdown is stable across re-opens."""
    src_dir = os.path.join(repo, TEMPLATE_DIR)
    if not os.path.isdir(src_dir):
        return []
    out: list[str] = []
    for name in os.listdir(src_dir):
        if not name.startswith(TEMPLATE_GLOB_PREFIX):
            continue
        if not name.endswith(".blend"):
            continue
        out.append(name[: -len(".blend")])
    return sorted(out)


def _template_enum_items(self, context):
    """EnumProperty items callback — must be a free function (Blender
    keeps a reference to whatever closure we return and a method bound
    to ``self`` can leak the operator instance). Empty list when the
    repo / tracks-src isn't resolvable; the operator's draw() surfaces
    that as a separate error so the dropdown emptiness is explained."""
    repo = _find_repo_root()
    if repo is None:
        return [("__none__", "(no repo)", "Open a .blend inside the hoverbike repo first")]
    templates = _list_templates(repo)
    if not templates:
        return [("__none__", "(no templates)", "No tracks-src/template-*.blend files found")]
    items: list[tuple[str, str, str]] = []
    for name in templates:
        blurb = TEMPLATE_BLURBS.get(name, "")
        label = name.removeprefix(TEMPLATE_GLOB_PREFIX).replace("-", " ").title()
        items.append((name, label, blurb))
    return items


class HOVERBIKE_OT_new_map_from_template(Operator):
    """Copy a ``tracks-src/template-*.blend`` to a fresh
    ``tracks-src/<id>.blend`` and open it. The new file inherits the
    template's terrain, spline, water volume, and start pose; the
    author can immediately edit it without the boilerplate of setting
    those up by hand."""

    bl_idname = "hoverbike.new_map_from_template"
    bl_label = "New Map from Template"
    bl_description = (
        "Duplicate a tracks-src/template-*.blend to tracks-src/<id>.blend and open it"
    )
    bl_options = {"REGISTER"}

    template: EnumProperty(  # type: ignore[valid-type]
        name="Template",
        description="Starter .blend to duplicate",
        items=_template_enum_items,
    )
    new_id: StringProperty(  # type: ignore[valid-type]
        name="New track id",
        description="Becomes the .blend filename + the in-game track id (lowercase letters, digits, dashes)",
        default="",
        maxlen=48,
    )
    overwrite: bpy.props.BoolProperty(  # type: ignore[valid-type]
        name="Overwrite if exists",
        description="If a tracks-src/<id>.blend already exists, replace it. Otherwise the operator aborts.",
        default=False,
    )

    def invoke(self, context, event):
        repo = _find_repo_root()
        if repo is None:
            self.report(
                {"ERROR"},
                "Open or save any .blend inside the hoverbike repo first — "
                "the operator needs a repo root to locate tracks-src/.",
            )
            return {"CANCELLED"}
        if not _list_templates(repo):
            self.report({"ERROR"}, f"No template-*.blend in {repo}/tracks-src/")
            return {"CANCELLED"}
        return context.window_manager.invoke_props_dialog(self, width=420)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "template")
        layout.prop(self, "new_id")
        layout.prop(self, "overwrite")
        # Surface validation feedback inline so authors fix the id
        # before hitting OK rather than getting a CANCELLED report.
        new_id = self.new_id.strip()
        if new_id:
            if not TRACK_ID_PATTERN.match(new_id):
                layout.label(
                    text="ID must be lowercase letters, digits, dashes",
                    icon="ERROR",
                )
            else:
                repo = _find_repo_root()
                target = os.path.join(repo or "", TEMPLATE_DIR, f"{new_id}.blend")
                if os.path.exists(target) and not self.overwrite:
                    layout.label(text=f"Already exists: {target}", icon="ERROR")

    def execute(self, context):
        repo = _find_repo_root()
        if repo is None:
            self.report({"ERROR"}, "Lost repo context — re-open a .blend in the repo.")
            return {"CANCELLED"}

        if self.template in ("__none__", ""):
            self.report({"ERROR"}, "Pick a template.")
            return {"CANCELLED"}

        new_id = self.new_id.strip()
        if not TRACK_ID_PATTERN.match(new_id):
            self.report(
                {"ERROR"},
                "Track id must be lowercase letters / digits / dashes "
                "(e.g. 'seattle-sprint', 'island-2').",
            )
            return {"CANCELLED"}

        src = os.path.join(repo, TEMPLATE_DIR, f"{self.template}.blend")
        dst = os.path.join(repo, TEMPLATE_DIR, f"{new_id}.blend")
        if not os.path.isfile(src):
            self.report({"ERROR"}, f"Template file vanished: {src}")
            return {"CANCELLED"}
        if os.path.exists(dst) and not self.overwrite:
            self.report(
                {"ERROR"},
                f"{dst} already exists. Toggle 'Overwrite if exists' to replace it.",
            )
            return {"CANCELLED"}

        try:
            shutil.copyfile(src, dst)
        except OSError as e:
            self.report({"ERROR"}, f"Copy failed: {e}")
            return {"CANCELLED"}

        # Open the freshly-copied .blend. The load handler in
        # handlers.py detects the new parent dir (``tracks-src``) and
        # flips the addon panel into track mode automatically.
        try:
            bpy.ops.wm.open_mainfile(filepath=dst)
        except Exception as e:  # noqa: BLE001 — Blender wraps a wide range
            self.report(
                {"WARNING"},
                f"Copied {dst} but couldn't open it automatically: {e}. "
                f"Open it manually via File → Open.",
            )
            return {"FINISHED"}

        self.report(
            {"INFO"},
            f"New map ready: {os.path.relpath(dst, repo)} (from {self.template}).",
        )
        return {"FINISHED"}


# ────────────────────────────────────────────────────────────────────
# Registration
# ────────────────────────────────────────────────────────────────────

_CLASSES: tuple[type, ...] = (HOVERBIKE_OT_new_map_from_template,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
