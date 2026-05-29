"""Add-on preferences — the project-root override.

The addon normally infers your hoverbike clone by walking up from the open
.blend (``find_repo_root`` in _legacy.py). That works when the .blend lives
inside the repo. When you author *outside* the repo instead — e.g. in a
Google-Drive-Desktop-synced ``tracks-src/`` so saves back up automatically
(see docs/asset-storage.md) — there's no clone above the .blend to find, so
exports can't locate ``public/`` + ``specs/``.

This preference (or the ``$HOVERBIKE_REPO_ROOT`` env var) names your clone
explicitly so export still writes into it. Leave it blank for the in-repo
workflow and the walk-up auto-detect kicks in as before.
"""

from __future__ import annotations

import bpy
from bpy.props import StringProperty
from bpy.types import AddonPreferences


class HoverbikeAddonPreferences(AddonPreferences):
    # Must match the addon's package name (the key under
    # bpy.context.preferences.addons[...]). For this package that's
    # "hoverbike_addon".
    bl_idname = __package__

    project_root: StringProperty(
        name="Project root",
        description=(
            "Path to your hoverbike repo clone. Set this only when you author "
            ".blend files outside the repo (e.g. a Google Drive folder) so "
            "exports still write into public/ and specs/. Leave blank to "
            "auto-detect from the open .blend's location"
        ),
        subtype="DIR_PATH",
        default="",
    )

    def draw(self, _context: bpy.types.Context) -> None:
        layout = self.layout
        layout.prop(self, "project_root")
        layout.label(
            text="Only needed when your .blend lives outside the repo clone.",
            icon="INFO",
        )


_CLASSES: tuple[type, ...] = (HoverbikeAddonPreferences,)


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
