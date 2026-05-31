"""Unit tests for the make-level-props resolver/manifest builder.

Pure stdlib (``unittest``) — runs under any Python with no extra deps,
matching tools/make_level_props.py itself::

    python tools/test_make_level_props.py        # exit 0 on success, 1 on failure

Regression cover for the two bugs found during the 2026-05-30 sandbar
vertical-slice run:

  * BUG 1 — ``resolve_props`` parsed only the per-track "unique" table, so
    the shared AI-suitable dressing kit in docs/tracks/README.md
    (``scatter_rocks`` → the rock family) never entered any track's AI lane
    and every track undercounted to ~1 prop.
  * BUG 2 — ``build_manifest`` preserved prior run state across a re-plan
    (seed/approved/concept/mesh/conditioned_glb/integrated) but NOT
    ``library_blend``, so re-running ``plan`` silently dropped the integrate
    output pointer.

The tests stand up their own throwaway track-docs + manifest dir so they
don't depend on (or mutate) the real, evolving docs and committed manifests.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import make_level_props as m  # noqa: E402


# A README with both common tables — only the dressing one carries
# AI-routable props; the "`scatter_rocks` / coral-debris" cell exercises the
# backtick-first name extraction (a raw "coral" would mis-route procedural).
README_MD = """# Test track-set docs

## Props — common to all tracks

### Required gameplay / system objects (every track JSON needs these)

| Prop | Kind / vocabulary | Notes |
|---|---|---|
| `emitter_explosion` | particle emitter (atlas_cell 1) | required |
| Racer grid | hoverbike entities | shared |

### Common environment dressing (present on most tracks)

| Prop | Kind / vocabulary | Where it appears |
|---|---|---|
| `emitter_gulls` | emitter (atlas_cell 5) | coastal |
| `scatter_rocks` / coral-debris | GN scatter of `prop_rock` | most |
| Ambient haze / dust-mote emitter | emitter (atlas_cell 4) | most |
| `scatter_palms` | GN scatter of `prop_palm` | tropical only |

## References
"""

# A track with NO AI-routable unique props — the common fold is what should
# give it an AI lane at all.
NO_AI_MD = """# NoAI

## Props — unique to NoAI

| Prop | Kind | Notes |
|---|---|---|
| `terrain_island` | terrain | central peak |
| `ramp_jump` | track | training ramp |
| `scatter_palms` | scatter (`prop_palm`) | sparse cove palms |
"""

# A track that already lists scatter_rocks in its unique table — the common
# fold must dedupe onto the same prop_id, not add a second sea_boulder.
HAS_ROCKS_MD = """# HasRocks

## Props — unique to HasRocks

| Prop | Kind | Notes |
|---|---|---|
| `scatter_rocks` | scatter (`prop_rock`) | ~15 sea stacks |
"""


class MakeLevelPropsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self.docs = os.path.join(root, "tracks")
        self.manifests = os.path.join(root, "manifests")
        os.makedirs(self.docs)
        os.makedirs(self.manifests)
        for name, body in (("README.md", README_MD),
                           ("no_ai.md", NO_AI_MD),
                           ("has_rocks.md", HAS_ROCKS_MD)):
            with open(os.path.join(self.docs, name), "w", encoding="utf-8") as f:
                f.write(body)
        # Point the module at the throwaway fixtures.
        self._orig_docs = m.TRACK_DOCS
        self._orig_manifests = m.MANIFEST_DIR
        m.TRACK_DOCS = self.docs
        m.MANIFEST_DIR = self.manifests

    def tearDown(self) -> None:
        m.TRACK_DOCS = self._orig_docs
        m.MANIFEST_DIR = self._orig_manifests
        self._tmp.cleanup()

    # ── BUG 1: common dressing fold ──────────────────────────────────

    def test_resolve_common_props_scopes_to_dressing_table(self):
        rows = {r["name"] for r in m.resolve_common_props()}
        # Dressing table is folded…
        self.assertIn("scatter_rocks", rows)
        self.assertIn("scatter_palms", rows)
        self.assertIn("emitter_gulls", rows)
        # …the Required gameplay/system table is NOT (would only add noise).
        self.assertNotIn("emitter_explosion", rows)
        self.assertNotIn("Racer grid", rows)

    def test_common_rocks_route_to_ai_rock_family(self):
        rocks = next(r for r in m.resolve_common_props()
                     if r["name"] == "scatter_rocks")
        c = m.classify(rocks)
        self.assertEqual(c["lane"], "ai")
        self.assertEqual(c["prop_id"], "sea_boulder")

    def test_common_palms_and_emitters_not_ai(self):
        by_name = {r["name"]: r for r in m.resolve_common_props()}
        self.assertEqual(m.classify(by_name["scatter_palms"])["lane"], "procedural")
        self.assertEqual(m.classify(by_name["emitter_gulls"])["lane"], "skip")
        self.assertEqual(
            m.classify(by_name["Ambient haze / dust-mote emitter"])["lane"],
            "skip")

    def test_build_manifest_folds_common_rock_into_ai_lane(self):
        # A track with zero AI-routable unique props gets sea_boulder from
        # the shared dressing kit (the core BUG 1 regression).
        mm = m.build_manifest("no_ai")
        ai_ids = [p["prop_id"] for p in mm["ai_props"]]
        self.assertEqual(ai_ids, ["sea_boulder"])
        sb = mm["ai_props"][0]
        self.assertEqual(sb["sources"], ["scatter_rocks (common dressing)"])

    def test_build_manifest_dedupes_unique_and_common_collision(self):
        # Unique scatter_rocks + common scatter_rocks → ONE sea_boulder, with
        # both provenance labels and no duplicate source string.
        mm = m.build_manifest("has_rocks")
        boulders = [p for p in mm["ai_props"] if p["prop_id"] == "sea_boulder"]
        self.assertEqual(len(boulders), 1)
        srcs = boulders[0]["sources"]
        self.assertIn("scatter_rocks", srcs)
        self.assertIn("scatter_rocks (common dressing)", srcs)
        self.assertEqual(len(srcs), len(set(srcs)))  # no dup strings

    def test_common_procedural_props_not_duplicated(self):
        # The unique table's scatter_palms is reported once; the common
        # dressing palms (procedural) is NOT folded in, so palm behaviour is
        # unchanged.
        mm = m.build_manifest("no_ai")
        palms = [p for p in mm["procedural_lane"]
                 if p["name"] == "scatter_palms"]
        self.assertEqual(len(palms), 1)

    # ── BUG 2: library_blend preserved across re-plan ────────────────

    def test_build_manifest_preserves_library_blend(self):
        # Seed a prior, fully-integrated manifest, then re-plan and confirm
        # the integrate output pointer survives.
        prior = {
            "level": "no_ai",
            "ai_props": [{
                "prop_id": "sea_boulder", "family": "rock",
                "subject": "x", "prompt": "x", "target_tris": 2000,
                "target_height": 6.0, "collider": "box", "tint": "#6b7075",
                "smooth": True, "mat_family": "prop", "catalog": "Rocks",
                "sources": ["scatter_rocks (common dressing)"],
                "seed": 999, "approved": True,
                "concept": "concept-art/props/no_ai/sea_boulder.png",
                "mesh": "tools/ai_prop_runs/no_ai/meshes/sea_boulder.glb",
                "conditioned_glb": "public/assets/props/ai/sea_boulder.glb",
                "integrated": True,
                "library_blend": "tracks-src/props/ai/sea_boulder.blend",
            }],
            "procedural_lane": [], "manual_review": [],
        }
        m.save_manifest("no_ai", prior)

        mm = m.build_manifest("no_ai")
        sb = next(p for p in mm["ai_props"] if p["prop_id"] == "sea_boulder")
        self.assertEqual(sb["library_blend"],
                         "tracks-src/props/ai/sea_boulder.blend")
        # Sibling run-state still preserved (guards against a regression that
        # drops these too).
        self.assertTrue(sb["integrated"])
        self.assertEqual(sb["seed"], 999)
        self.assertEqual(sb["conditioned_glb"],
                         "public/assets/props/ai/sea_boulder.glb")

    def test_build_manifest_library_blend_none_when_no_prior(self):
        # Fresh plan: the field is present (so the key never KeyErrors
        # downstream) but null until integrate runs.
        mm = m.build_manifest("no_ai")
        sb = next(p for p in mm["ai_props"] if p["prop_id"] == "sea_boulder")
        self.assertIn("library_blend", sb)
        self.assertIsNone(sb["library_blend"])

    # ── Orphan preservation across re-plan ───────────────────────────

    def _seed_prior(self, *extra_props):
        prior = {
            "level": "no_ai",
            "ai_props": [{
                "prop_id": "sea_boulder", "family": "rock", "subject": "x",
                "prompt": "x", "target_tris": 2000, "target_height": 6.0,
                "collider": "box", "tint": "#6b7075", "smooth": True,
                "mat_family": "prop", "catalog": "Rocks",
                "sources": ["scatter_rocks (common dressing)"], "seed": 1,
                "approved": True, "concept": None, "mesh": None,
                "conditioned_glb": None, "integrated": False,
                "library_blend": None,
            }, *extra_props],
            "procedural_lane": [], "manual_review": [],
        }
        m.save_manifest("no_ai", prior)

    def test_has_work_predicate(self):
        self.assertFalse(m._ai_prop_has_work({"approved": None}))
        self.assertFalse(m._ai_prop_has_work({"seed": 7, "integrated": False}))
        self.assertTrue(m._ai_prop_has_work({"approved": False}))  # explicit reject
        self.assertTrue(m._ai_prop_has_work({"concept": "x.png"}))
        self.assertTrue(m._ai_prop_has_work({"integrated": True}))
        self.assertTrue(m._ai_prop_has_work({"library_blend": "x.blend"}))

    def test_worked_orphan_is_preserved(self):
        # A fully-integrated prop the docs no longer list (the sandbar
        # vertical-slice case) survives a re-plan, tagged and with its
        # GLB/blend pointers intact.
        self._seed_prior({
            "prop_id": "drowned_cab", "family": "vehicle", "subject": "x",
            "prompt": "x", "target_tris": 2500, "target_height": 2.6,
            "collider": "box", "tint": "#b8902a", "smooth": False,
            "mat_family": "prop", "catalog": "Urban",
            "sources": ["drowned vehicle (hand-seed)"], "seed": 5,
            "approved": True, "concept": "concept-art/props/no_ai/drowned_cab.png",
            "mesh": "tools/ai_prop_runs/no_ai/meshes/drowned_cab.glb",
            "conditioned_glb": "public/assets/props/ai/drowned_cab.glb",
            "integrated": True,
            "library_blend": "tracks-src/props/ai/drowned_cab.blend",
        })
        mm = m.build_manifest("no_ai")
        cab = next((p for p in mm["ai_props"] if p["prop_id"] == "drowned_cab"), None)
        self.assertIsNotNone(cab, "worked orphan was dropped")
        self.assertTrue(cab["orphan"])
        self.assertEqual(cab["library_blend"],
                         "tracks-src/props/ai/drowned_cab.blend")
        self.assertEqual(cab["conditioned_glb"],
                         "public/assets/props/ai/drowned_cab.glb")
        # The resolved prop is NOT tagged orphan.
        sb = next(p for p in mm["ai_props"] if p["prop_id"] == "sea_boulder")
        self.assertNotIn("orphan", sb)

    def test_plan_only_orphan_is_dropped(self):
        # A stale prior entry with no work done is re-resolvable for free, so
        # it's dropped rather than kept forever.
        self._seed_prior({
            "prop_id": "ghost_rock", "family": "rock", "subject": "x",
            "prompt": "x", "target_tris": 2000, "target_height": 6.0,
            "collider": "box", "tint": "#6b7075", "smooth": True,
            "mat_family": "prop", "catalog": "Rocks", "sources": ["ghost"],
            "seed": 12345, "approved": None, "concept": None, "mesh": None,
            "conditioned_glb": None, "integrated": False, "library_blend": None,
        })
        mm = m.build_manifest("no_ai")
        ids = [p["prop_id"] for p in mm["ai_props"]]
        self.assertNotIn("ghost_rock", ids)

    def test_orphan_tag_clears_when_prop_reresolves(self):
        # If a prop that was tagged orphan later reappears in the docs, the
        # rebuilt entry is fresh (no stale orphan tag carried over).
        self._seed_prior()
        # Re-mark the resolved sea_boulder as a stale orphan in the prior file.
        m_prior = m.load_manifest("no_ai")
        for p in m_prior["ai_props"]:
            if p["prop_id"] == "sea_boulder":
                p["orphan"] = True
        m.save_manifest("no_ai", m_prior)

        mm = m.build_manifest("no_ai")
        sb = next(p for p in mm["ai_props"] if p["prop_id"] == "sea_boulder")
        self.assertNotIn("orphan", sb)


if __name__ == "__main__":
    unittest.main(verbosity=2)
