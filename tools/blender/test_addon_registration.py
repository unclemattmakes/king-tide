"""Headless smoke test: confirm the Hoverbike addon registers every
operator and panel it claims to.

Run from a Node wrapper (``pnpm test:blender``) which feeds this script
to a background Blender. The test:

  1. Enables the addon (fails the run if enable itself raises).
  2. Reads the addon module's ``_classes`` tuple — the addon's own
     declaration of what *should* register.
  3. For every ``HOVERBIKE_OT_*`` / ``HOVERBIKE_PT_*`` class in
     ``_classes``, verifies the class is actually present in
     ``bpy.types.Operator.__subclasses__()`` or
     ``bpy.types.Panel.__subclasses__()``. Catches the silent
     mid-registration failure that bit us in the addon-drift incident
     (registration succeeded for everything before a broken class and
     stopped after it, with no exception bubbled to the caller).
  4. Cross-checks the module's source for ``class HOVERBIKE_OT_…`` /
     ``class HOVERBIKE_PT_…`` declarations not present in ``_classes``.
     Catches "added a class, forgot to add it to the registration
     tuple", a foot-gun the manual-tuple registration design invites.

Exits 0 on success, 1 on any failure (with a per-class report).
"""

from __future__ import annotations

import re
import sys
from typing import Iterable

import bpy

ADDON_MODULE = "hoverbike_addon"
EXPECTED_PREFIXES = ("HOVERBIKE_OT_", "HOVERBIKE_PT_")


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


def _module_declared_classes(module) -> tuple[set[str], set[str]]:
    """(_classes_tuple_names, source_file_class_names)

    The first set is what the addon promises to register; the second is
    every class defined in the source file. Their symmetric difference
    is the foot-gun zone."""
    classes_tuple = getattr(module, "_classes", None)
    if classes_tuple is None:
        _fail(f"{ADDON_MODULE} has no top-level `_classes` tuple — registration design changed?")
        sys.exit(1)
    tuple_names = {c.__name__ for c in classes_tuple}

    source_names: set[str] = set()
    try:
        with open(module.__file__, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^class\s+(HOVERBIKE_(?:OT|PT)_\w+)\s*\(", line)
                if m:
                    source_names.add(m.group(1))
    except OSError as e:
        _fail(f"could not read source at {module.__file__}: {e}")
        sys.exit(1)
    return tuple_names, source_names


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

    import sys as _sys
    module = _sys.modules.get(ADDON_MODULE)
    if module is None:
        _fail(f"addon enabled but module not in sys.modules — something is very wrong")
        return 1

    tuple_names, source_names = _module_declared_classes(module)
    registered = _filter(_registered_class_names())
    expected = _filter(tuple_names)
    in_source = _filter(source_names)

    failures: list[str] = []

    # Check 1: every class in _classes should actually be registered.
    missing_from_registration = expected - registered
    for name in sorted(missing_from_registration):
        failures.append(f"class {name} is in `_classes` but failed to register")

    # Check 2: every HOVERBIKE_OT/PT class in the source should be in _classes.
    # If you defined a class but didn't add it to `_classes`, Blender will
    # quietly never register it and your UI will silently miss buttons.
    missing_from_tuple = in_source - expected
    for name in sorted(missing_from_tuple):
        failures.append(
            f"class {name} is defined in {ADDON_MODULE}.py but not listed in `_classes` "
            f"(it'll never be registered)"
        )

    # Pass-through summary.
    print(f"[addon-smoke] addon module: {module.__file__}")
    print(f"[addon-smoke] classes declared in _classes:  {len(expected)} (OT/PT only)")
    print(f"[addon-smoke] classes defined in source file: {len(in_source)} (OT/PT only)")
    print(f"[addon-smoke] classes registered with Blender: {len(registered)} (OT/PT only)")

    if failures:
        for f in failures:
            _fail(f)
        print(f"[addon-smoke] FAILED ({len(failures)} issue(s))", file=sys.stderr)
        return 1

    _ok(f"all {len(expected)} HOVERBIKE_OT/PT classes register cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
