"""Headless smoke test: confirm the King Tide addon registers every
operator and panel it claims to.

Run from a Node wrapper (``pnpm test:blender``) which feeds this script
to a background Blender. The test:

  1. Enables the addon (fails the run if enable itself raises).
  2. Walks every ``.py`` file inside the addon (or just the file if
     the addon is still a single .py) and finds every class declared
     with the ``KINGTIDE_OT_…`` / ``KINGTIDE_PT_…`` prefix.
  3. Asserts each declared class is actually present in
     ``bpy.types.Operator.__subclasses__()`` or
     ``bpy.types.Panel.__subclasses__()``. Catches the silent
     mid-registration failure that bit us in the addon-drift incident
     (registration succeeded for everything before a broken class and
     stopped after it, with no exception bubbled to the caller).

This shape works through the in-progress monolith → package refactor:
during the migration each module owns its own ``register()`` /
``unregister()``, so there's no single ``_classes`` tuple to read.
Walking source declarations is the durable contract — anything you
``class KINGTIDE_OT_foo`` must end up registered, period.

Exits 0 on success, 1 on any failure (with a per-class report).
"""

from __future__ import annotations

import os
import re
import sys
from typing import Iterable

import bpy

ADDON_MODULE = "kingtide_addon"
EXPECTED_PREFIXES = ("KINGTIDE_OT_", "KINGTIDE_PT_")
CLASS_DECL_PATTERN = re.compile(r"^class\s+(KINGTIDE_(?:OT|PT)_\w+)\s*\(", re.MULTILINE)


def _fail(msg: str) -> None:
    print(f"[addon-smoke] FAIL: {msg}", file=sys.stderr)


def _ok(msg: str) -> None:
    print(f"[addon-smoke] ok: {msg}")


def _registered_class_names() -> set[str]:
    """Names of every Operator/Panel currently registered with Blender.

    We rely on ``__subclasses__()`` because that's exactly what Blender
    uses internally — if a class isn't in this set, the addon's UI /
    operators can't find it either."""
    names: set[str] = set()
    for cls in bpy.types.Operator.__subclasses__():
        names.add(cls.__name__)
    for cls in bpy.types.Panel.__subclasses__():
        names.add(cls.__name__)
    return names


def _addon_source_files(module) -> list[str]:
    """Every .py file that contributes to the addon. Handles both
    layouts:

      * single-file addon (legacy): ``kingtide_addon.py``
      * package addon: ``kingtide_addon/__init__.py`` + siblings

    For a package we walk recursively under the package root so a
    future ``kingtide_addon/road/operators.py`` would still be scanned.
    """
    files: list[str] = []
    if hasattr(module, "__path__"):
        # Package — walk the directory.
        for pkg_dir in module.__path__:
            for root, _, names in os.walk(pkg_dir):
                for name in names:
                    if name.endswith(".py"):
                        files.append(os.path.join(root, name))
    else:
        files.append(module.__file__)
    return files


def _scan_declared_classes(module) -> set[str]:
    """All KINGTIDE_OT/PT classes declared anywhere in the addon's
    source tree. Raw lexical scan — doesn't care about indentation /
    conditional definition; if it looks like a class declaration, we
    expect it to register."""
    declared: set[str] = set()
    for path in _addon_source_files(module):
        try:
            with open(path, encoding="utf-8") as f:
                src = f.read()
        except OSError as e:
            _fail(f"could not read {path}: {e}")
            sys.exit(1)
        for match in CLASS_DECL_PATTERN.finditer(src):
            declared.add(match.group(1))
    return declared


def _filter(names: Iterable[str]) -> set[str]:
    return {n for n in names if n.startswith(EXPECTED_PREFIXES)}


def main() -> int:
    # Enable the addon. If this raises, the user's first signal is the
    # traceback — but in past incidents Blender swallowed the registration
    # error and exposed it as "panels just don't show up". The follow-up
    # checks below catch that case.
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_MODULE)
    except Exception as e:
        _fail(f"addon_enable({ADDON_MODULE!r}) raised: {e}")
        return 1

    module = sys.modules.get(ADDON_MODULE)
    if module is None:
        _fail(f"addon enabled but module not in sys.modules — something is very wrong")
        return 1

    declared = _scan_declared_classes(module)
    registered = _filter(_registered_class_names())

    failures: list[str] = []

    # Every declared KINGTIDE_OT/PT class must actually be registered.
    # Catches:
    #   * Class defined but not added to any module's register() — the
    #     manual-tuple foot-gun.
    #   * register() raised partway through and Blender swallowed it —
    #     the silent failure mode that bit us in the addon-drift
    #     incident (everything after the broken class quietly missed).
    missing = declared - registered
    for name in sorted(missing):
        failures.append(f"class {name} declared in source but not registered with Blender")

    # Pass-through summary so a passing run still tells you the count.
    layout = "package" if hasattr(module, "__path__") else "single-file"
    location = getattr(module, "__path__", [module.__file__])[0]
    print(f"[addon-smoke] addon module: {ADDON_MODULE} ({layout}) at {location}")
    print(f"[addon-smoke] KINGTIDE_OT/PT classes declared in source: {len(declared)}")
    print(f"[addon-smoke] KINGTIDE_OT/PT classes registered with Blender: {len(registered)}")

    if failures:
        for f in failures:
            _fail(f)
        print(f"[addon-smoke] FAILED ({len(failures)} issue(s))", file=sys.stderr)
        return 1

    _ok(f"all {len(declared)} KINGTIDE_OT/PT classes register cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
