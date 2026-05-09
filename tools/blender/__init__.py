"""Shared Blender pipeline for hoverbike asset generation.

See docs/asset-pipeline-guide.md for the author-facing walkthrough and
docs/asset-pipeline-plan.md for the architectural design.

Each builder script (build_bike.py, build_prop.py, build_track.py) is a
Blender headless entry point: it reads a JSON spec via the
HOVERBIKE_SPEC environment variable, assembles the scene from kit
geometry in lib/, applies spec-driven parameters, validates the
extras-driven contract, and exports a GLB to HOVERBIKE_OUTPUT.

The modules in this package (common, sockets, colliders, lib_loader)
are the shared plumbing those builders rely on.
"""
