"""Headless smoke test: resolve every lazy import inside the Hoverbike
addon, fail fast if any references a name that isn't actually exported.

Background. The addon does ``from ._legacy import _foo`` inside
operator ``execute()`` methods to dodge load-order cycles between
domain modules. These lazy imports only fire when an operator is
invoked — class registration succeeds even when the import target is
missing. That's how the May-2026 carve-out shipped five phantom
helpers (``_largest_terrain_mesh``, ``_sample_curve_to_polyline``,
``_spline_iter_points``, ``_find_layer_collection``, plus two more
that lived in road.py but were imported from ``_legacy``):

  * ``pnpm test:blender`` passed (57/57 classes registered).
  * Blender's panel rendered.
  * Every authoring tool (tunnel, road, downtown, sculpt, lint) blew
    up the moment a user clicked it, because the lazy import inside
    ``execute()`` hit an AttributeError mid-call.

This test parses every Python file in the addon, finds every
``from .<module> import <names>`` statement (lazy or not), and
verifies each imported name is actually present on the referenced
module after the addon is enabled. Catches the exact "import target
disappeared" failure mode without having to invoke each operator.

Exit 0 on success, 1 on any failure.
"""

from __future__ import annotations

import ast
import importlib
import os
import sys
from typing import Iterable

import bpy

ADDON_MODULE = "hoverbike_addon"


def _fail(msg: str) -> None:
    print(f"[addon-imports] FAIL: {msg}", file=sys.stderr)


def _addon_source_files(module) -> list[str]:
    files: list[str] = []
    if hasattr(module, "__path__"):
        for pkg_dir in module.__path__:
            for root, _, names in os.walk(pkg_dir):
                for name in names:
                    if name.endswith(".py"):
                        files.append(os.path.join(root, name))
    else:
        files.append(module.__file__)
    return files


def _collect_relative_imports(path: str) -> Iterable[tuple[str, str, int]]:
    """Yield ``(module, name, lineno)`` for every ``from .X import Y``
    in ``path``. Walks the AST so it catches imports nested inside
    function bodies (where most lazy imports live) just as well as
    module-top-level imports. ``module`` is the leading ``.X`` (e.g.
    ``_legacy``); ``name`` is each imported symbol."""
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        _fail(f"could not read {path}: {e}")
        return
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        _fail(f"syntax error in {path}: {e}")
        return
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            # `from . import X` (no module) is fine — that imports a
            # submodule by name, not a symbol; skip those.
            if node.level != 1 or node.module is None:
                continue
            mod_name = node.module
            for alias in node.names:
                if alias.name == "*":
                    # `from .X import *` — can't statically resolve.
                    continue
                yield mod_name, alias.name, node.lineno


def main() -> int:
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_MODULE)
    except Exception as e:
        _fail(f"addon_enable({ADDON_MODULE!r}) raised: {e}")
        return 1

    addon = sys.modules.get(ADDON_MODULE)
    if addon is None:
        _fail("addon enabled but not in sys.modules")
        return 1

    failures: list[str] = []
    checked = 0
    for path in _addon_source_files(addon):
        rel = os.path.relpath(path, os.path.dirname(addon.__file__))
        for mod_name, sym_name, lineno in _collect_relative_imports(path):
            checked += 1
            full_name = f"{ADDON_MODULE}.{mod_name}"
            try:
                target = importlib.import_module(full_name)
            except Exception as e:
                failures.append(
                    f"{rel}:{lineno} — from .{mod_name} import {sym_name} — "
                    f"target module would not import: {e}"
                )
                continue
            if not hasattr(target, sym_name):
                failures.append(
                    f"{rel}:{lineno} — from .{mod_name} import {sym_name} — "
                    f"{full_name} has no attribute {sym_name!r}"
                )

    print(f"[addon-imports] checked {checked} relative imports across the addon")

    if failures:
        for f in failures:
            _fail(f)
        print(f"[addon-imports] FAILED ({len(failures)} broken import(s))", file=sys.stderr)
        return 1

    print(f"[addon-imports] ok: all {checked} relative imports resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
