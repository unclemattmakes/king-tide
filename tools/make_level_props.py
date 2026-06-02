"""make-level-props — orchestrate the local AI prop pipeline over a whole level.

This is the level-scale driver for the three-stage, fully-local, free prop
factory documented in ``docs/ai-prop-pipeline.md``:

    text prompt ──[ComfyUI / SDXL]──▶ concept image
                ──[Hunyuan3D]──▶ dense mesh
                ──[condition_ai_mesh]──▶ prop_<id> (decimate + mat + COLOR_0 + collider)

Every individual stage already exists and is proven end-to-end. This tool
automates the chain across an *entire level's* prop list with:

  1. RESOLVE  — parse the per-track design doc for the level's prop list.
  2. ROUTE    — classify each prop's archetype and auto-route compact/solid
                subjects to the AI lane, thin/spanning ones to a flagged
                procedural list (the subject-suitability rule from
                docs/props-production-plan.md).
  3. BATCH    — phase the 8 GB GPU: ComfyUI generates ALL concepts, then
                (after a review gate) Hunyuan meshes ALL approved concepts,
                then the conditioner runs on every mesh. Each model loads
                once; the VRAM is handed back and forth exactly as the doc
                prescribes (stop Hunyuan / free ComfyUI between phases).
  4. REVIEW   — a contact-sheet-at-the-end gate before any GPU meshing time
                is spent, and a second gate before anything is locked into
                the shared library. AI output is never auto-committed.
  5. INTEGRATE— write each conditioned prop to its OWN .blend in the
                Drive-synced content root
                (<content-root>/tracks-src/props/ai/<id>.blend, out of git) —
                one asset-marked, hv_locked collection per file. The folder
                is the library, scanned recursively by Blender's Asset
                Browser. This honours the raw-vs-compiled split: the raw
                .blend goes to the content root, the compiled GLB stays in
                the repo. Per-file = smallest blast radius: a regen rewrites
                one small file, never the shared procedural library or a
                sibling. AI output is not reproducible, so the conditioned
                GLB (Git LFS) + the saved prompt are the source of truth,
                not a regenerate step.

The pipeline is phase-by-phase by design: it STOPS at each human gate. A
typical session is::

    python tools/make_level_props.py the-maw plan        # resolve + route
    python tools/make_level_props.py the-maw concepts    # Phase A (ComfyUI)
    # …review <content-root>/concept-art/props/the-maw/_contact_sheet.html…
    python tools/make_level_props.py the-maw approve sea_boulder rubble_chunk
    python tools/make_level_props.py the-maw mesh         # Phase B (Hunyuan)
    python tools/make_level_props.py the-maw condition    # Phase C (Blender)
    # …eyeball public/assets/props/ai/*.glb in ?viewer=…
    python tools/make_level_props.py the-maw integrate    # one .blend per prop → content root

Pure stdlib — runs under any Python (matches tools/comfyui_gen.py). The GPU
stages are strictly serialized; only classification / prompt-crafting is
embarrassingly parallel and is encoded here as a deterministic, reviewable
archetype table rather than live model calls.

Machine config is read from env vars with the documented Windows defaults
(see docs/ai-prop-pipeline.md). Nothing here is machine-specific beyond
those defaults.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ── Paths ────────────────────────────────────────────────────────────
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACK_DOCS = os.path.join(REPO_ROOT, "docs", "tracks")
# Live run state + the committed reproducibility anchor (prompts, seeds,
# params, approvals, provenance). specs/ is normal git.
MANIFEST_DIR = os.path.join(REPO_ROOT, "specs", "props", "ai")
# Throwaway scratch (raw Hunyuan meshes, Blender spec files, server logs) —
# gitignored, safe to delete between runs.
RUN_DIR = os.path.join(REPO_ROOT, "tools", "ai_prop_runs")
# Durable, committed AI output (Git LFS via *.glb / *.png) — the COMPILED
# half of the raw-vs-compiled split (docs/asset-storage.md): exports go to
# the repo.
ASSET_DIR = os.path.join(REPO_ROOT, "public", "assets", "props", "ai")
# Raw authoring .blends live in the Drive-synced content root, OUT of git —
# the RAW half of the split. Mirrors the tracks-src/ layout that holds the
# track/landmark sources. One asset-marked .blend per prop; the content
# root's tracks-src/ is already a registered (recursive) Blender asset
# library, so these show up next to the procedural props automatically.
# Override with $HOVERBIKE_CONTENT_ROOT (matches tools/convert-music.mjs).
CONTENT_ROOT = os.environ.get("HOVERBIKE_CONTENT_ROOT", r"C:\project-content\hoverbike")
LIB_BLEND_DIR = os.path.join(CONTENT_ROOT, "tracks-src", "props", "ai")
# Concept art (the SDXL PNGs + the review contact sheet) is raw authoring
# too — it lives in the content root's concept-art folder (Drive-backed, out
# of git), NOT in the gitignored scratch dir, so iterations are kept next to
# the bike/track concept art. The committed anchor is still the GLB + the
# prompt in the manifest; the concept image is an intermediate toward it.
CONCEPT_ART_DIR = os.path.join(CONTENT_ROOT, "concept-art", "props")

# ── Server / tool config (env-overridable, Windows defaults per the doc) ─
COMFY_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
HUNYUAN_URL = os.environ.get("HUNYUAN_URL", "http://127.0.0.1:8080")
COMFY_DIR = os.environ.get("COMFYUI_DIR", r"C:\Users\<user>\git\ComfyUI")
COMFY_PY = os.environ.get(
    "COMFYUI_PY", r"C:\Users\<user>\miniconda3\envs\comfyui\python.exe")
HUNYUAN_DIR = os.environ.get(
    "HUNYUAN_DIR", r"C:\Users\<user>\git\ai-gen\Hunyuan3D-2")
HUNYUAN_PY = os.environ.get(
    "HUNYUAN_PY", r"C:\Users\<user>\miniconda3\envs\hunyuan\python.exe")

_BLENDER_DEFAULTS = {
    "win32": r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe",
    "darwin": "/Applications/Blender.app/Contents/MacOS/Blender",
    "linux": "/opt/blender/blender",
}


def resolve_blender() -> str:
    """Mirror tools/gen.mjs: $BLENDER_EXE, else the platform default."""
    from_env = os.environ.get("BLENDER_EXE")
    if from_env and os.path.isfile(from_env):
        return from_env
    default = _BLENDER_DEFAULTS.get(sys.platform)
    if default and os.path.isfile(default):
        return default
    raise SystemExit(
        f"[make-props] Blender not found. Set $BLENDER_EXE (tried {default}).")


# The shared concept-art recipe from docs/ai-prop-pipeline.md — wraps a
# per-archetype subject so Hunyuan's rembg cuts it cleanly and image-to-3D
# gets the single isolated solid it reconstructs best.
PROMPT_RECIPE = (
    "a single {subject}, one isolated centered object on a plain solid white "
    "background, studio product photography, soft even lighting, full object "
    "in frame, sharp focus, game asset reference")


# ── Archetype table — the routing brain ──────────────────────────────
#
# Each AI family carries everything the downstream stages need: the prompt
# subject (worded TOWARD solidity per the subject rule), the conditioner
# params, and the asset-browser catalogue it lands in. The ``prop_id`` is
# deliberately chosen to NOT collide with any id the props-library seed
# emits — a colliding name (e.g. ``rock``) would make the prop seed-owned
# and the known prop_rock/prop_palm GN-group gap (docs/asset-pipeline-guide.md)
# would let a re-seed regenerate over it. New ids are author-added and
# fully preserved (and we still set hv_locked).

class AIFamily:
    def __init__(self, *, prop_id, subject, target_tris, target_height,
                 collider="box", tint="#8a8782", smooth=True, family="prop",
                 catalog="Rocks", unique=False):
        self.prop_id = prop_id          # shared output id (or slug stem if unique)
        self.subject = subject          # plugged into PROMPT_RECIPE
        self.target_tris = target_tris
        self.target_height = target_height
        self.collider = collider
        self.tint = tint
        self.smooth = smooth
        self.family = family            # material family: mat_<family>_<id>
        self.catalog = catalog          # Asset-Browser sub-catalogue
        # When True, the source prop name (not the family) drives the id —
        # e.g. distinct hero sculpts must not collapse onto one prop.
        self.unique = unique


# Families. The compact/solid forms from the subject-suitability table.
# Each ``subject`` is a bare noun phrase worded TOWARD solidity — it is
# plugged into PROMPT_RECIPE ("a single {subject}, …"), which owns the
# "a single" framing, so subjects must NOT repeat it.
#
# target_height is in GAME metres, scaled ~3x above real-world size:
# realistically-sized props read too small next to the bike + track at
# race pace (empirical, 2026-05-31). Bump target_height here (not a
# track's placement size) when props look undersized in the
# ?track=prop-showcase validation scene.
AI_FAMILIES = {
    "rock": AIFamily(
        prop_id="sea_boulder", catalog="Rocks", tint="#6b7075",
        target_tris=2000, target_height=18.0, smooth=True,
        subject=("massive solid weathered sea boulder, rounded ocean rock, "
                 "barnacle and algae crusted, closed compact form")),
    "rubble": AIFamily(
        prop_id="rubble_chunk", catalog="Rocks", tint="#8a8276",
        target_tris=1500, target_height=9.0, smooth=True,
        subject=("solid chunk of broken concrete and brick rubble, compact "
                 "debris block, rounded weathered masonry")),
    "wreck": AIFamily(
        prop_id="boat_wreck", catalog="Open Sea", tint="#5d6b6e",
        target_tris=2500, target_height=15.0, smooth=True,
        subject=("solid half-sunken fishing boat hull wreck, compact weathered "
                 "rusted hull, no masts or rigging")),
    "vehicle": AIFamily(
        prop_id="drowned_cab", catalog="Urban", tint="#b8902a",
        target_tris=2500, target_height=7.8, smooth=False, collider="box",
        subject=("solid submerged taxi cab car body, rounded compact closed "
                 "shell, algae covered, no thin antennae")),
    "anchor": AIFamily(
        prop_id="ship_anchor", catalog="Industrial", tint="#4a4640",
        target_tris=1500, target_height=9.0, smooth=False,
        subject="solid rusted heavy iron ship anchor, compact closed form"),
    "vessel": AIFamily(  # urns / chests / amphorae / pots
        prop_id="relic_urn", catalog="Rocks", tint="#7a5a3a",
        target_tris=1500, target_height=6.0, smooth=True,
        subject="solid ancient ceramic urn, rounded compact closed pottery, weathered"),
    "statue": AIFamily(
        prop_id="statue", catalog="Rocks", tint="#5e8b78", unique=True,
        target_tris=4000, target_height=36.0, smooth=True,
        subject=("solid weathered monumental statue, full standing figure, "
                 "verdigris copper, closed compact sculpt")),
    "idol": AIFamily(
        prop_id="carved_idol", catalog="Jungle", tint="#7d7a66", unique=True,
        target_tris=3000, target_height=12.0, smooth=True,
        subject=("solid carved stone idol head, compact closed sculpt, mossy "
                 "weathered temple stone")),
    "sea_life": AIFamily(
        prop_id="sea_creature", catalog="Open Sea", tint="#7d8a93", unique=True,
        target_tris=3000, target_height=12.0, smooth=True,
        subject=("solid smooth sea creature body sculpture, compact closed "
                 "form, no thin fins")),
    "shack": AIFamily(  # cared-for marina / pilot huts — the built "45%" hero
        prop_id="pilot_shack", catalog="Urban", tint="#6aa0a8", unique=True,
        target_tris=3500, target_height=14.0, smooth=False, collider="box",
        subject=("solid compact weathered marina pilot shack cabin, closed "
                 "boxy hut, corrugated metal roof, painted wood plank walls, "
                 "no thin stilts wires antennae or signage poles")),
}


# Routing rules, tried in order. Each entry is (regex, action) where action
# is either an AI family key (str) or a ("procedural", reason) tuple. The
# first match wins; emitters and gameplay objects are dropped earlier.
#
# NOTE on plurals: design-doc prop tables freely pluralize ("Rock arches",
# "sea stacks", "yellow cabs"). A naive ``\bword\b`` misses every plural,
# so each stem carries an explicit ``s?`` (or ``\w*`` where the plural is
# irregular, e.g. arch→arches). The boundary is kept on the *front* so
# risky short stems ("car") don't match inside longer words ("carved").
ROUTES: list[tuple[str, object]] = [
    # ── Procedural / bespoke (thin, spanning, or large set-piece) ──────
    (r"\barch\w*|\b(tunnel|rialto)s?\b",
     ("procedural", "spanning arch — image-to-3D fragments it; clean procedural sweep")),
    (r"\b(tower|lighthouse|spire|campanile|skyscraper|minaret)s?\b",
     ("procedural", "tower — a clean procedural cylinder beats a fragmented AI guess")),
    (r"\b(sea ?stack|stack)s?\b",
     ("procedural", "sea-stack — columnar; procedural primitive beats fragmented AI")),
    (r"\b(bridge|cable|pier|piling|pylon|mast|gantry|crane|antenna|lattice|"
     r"column|pillar|dock|jetty|wharf|boardwalk|bollard)s?\b",
     ("procedural", "thin/spanning structure — fragments in image-to-3D")),
    (r"\b(palm|kelp|coral|frond|foliage|tree|fern|root|strangler|vine|reed|grass)s?\b",
     ("procedural", "thin/branching foliage — use the procedural sway prop")),
    (r"\b(cliff|ridge|waterfall|fall|headland|caldera|escarpment)s?\b",
     ("procedural", "large bespoke terrain geometry, not a scatter prop")),
    (r"\b(gate|spike|crown|fence|railing|grille)s?\b",
     ("procedural", "thin/spanning gate-like form — fragments in image-to-3D")),
    (r"\b(wall|basin|pool|slide|lazy ?river|half-?pipe|ramp|deck|berm)s?\b",
     ("procedural", "large water-feature / track structure — bespoke geometry")),
    (r"\b(dome|plinth|fascia|signage|billboard|sign|neon|facade|superstructure)s?\b",
     ("procedural", "architectural flat / facade — procedural or CC0")),
    (r"\b(wheel|ferris|carousel)s?\b",
     ("procedural", "spoked/thin ride structure — fragments in image-to-3D")),
    (r"\bhorizon ring\b|\b(downtown|rooftop grid|building grid|skyline)s?\b",
     ("procedural", "bespoke skyline / horizon silhouette — not a scatter prop")),
    # ── AI lane (compact / solid / closed) ─────────────────────────────
    (r"\b(rock|boulder|cobble)s?\b", "rock"),
    (r"\b(rubble|debris|masonry|brick|concrete|chunk|rebar)s?\b", "rubble"),
    (r"\b(wreck|hull|ferry|boat|dinghy|trawler)s?\b|half-?sunk|sunken boat|fishing boat", "wreck"),
    (r"\b(cab|taxi|car|truck|vehicle|auto)s?\b", "vehicle"),
    (r"\banchors?\b", "anchor"),
    (r"\b(urn|amphora|amphorae|chest|pot|vase|jar)s?\b", "vessel"),
    (r"\b(statue|liberty|monument|effigy)s?\b", "statue"),
    (r"\b(idol|carved face|carved head|bayon|deity)s?\b", "idol"),
    (r"\b(shack|hut|cabin|shanty|boathouse|cottage|kiosk)s?\b", "shack"),
    (r"\b(shark|turtle|whale|dolphin|ray|fish|creature)s?\b", "sea_life"),
]

# Kinds in the per-track tables we never route to a mesh lane.
_SKIP_KIND = re.compile(r"emitter|sky|camera|spline|checkpoint|zone|water", re.I)
# Names that are gameplay/system objects (belt-and-suspenders with kind).
# Matched against the RAW lower-cased name (underscores intact), so the
# snake_case gameplay ids land here, not in manual review.
_SKIP_NAME = re.compile(
    r"emitter|^cp_|^start_|^boost|^pickup|wave_zone|camera_hero|"
    r"ai_spline|road_curve|^road_|_road$|^route_|^terrain_", re.I)


def _slug(text: str) -> str:
    """A safe prop-id stem from a free-text prop name."""
    s = re.sub(r"[`*]", "", text).lower()
    s = re.sub(r"[×x]\s*\d+", "", s)            # drop "×4" counts
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    s = re.sub(r"_+", "_", s)
    return s[:40] or "prop"


# ── Level prop resolution (parse the per-track design doc) ────────────

def _level_doc(level: str) -> str:
    path = os.path.join(TRACK_DOCS, f"{level}.md")
    if not os.path.isfile(path):
        avail = ", ".join(sorted(
            f[:-3] for f in os.listdir(TRACK_DOCS)
            if f.endswith(".md") and f != "README.md"))
        raise SystemExit(
            f"[make-props] no track doc for {level!r} at {path}\n"
            f"             available levels: {avail}")
    return path


def resolve_props(level: str) -> list[dict]:
    """Parse the ``## Props — unique to <track>`` markdown table.

    Returns a deduped list of ``{name, kind, notes}`` for every prop row,
    in document order. Robust to junk/duplicate rows (the Liberty doc has
    repeated emitter rows) — dedup is by (name, notes)."""
    with open(_level_doc(level), "r", encoding="utf-8") as f:
        lines = f.readlines()

    rows: list[dict] = []
    seen: set = set()
    in_props = False
    for ln in lines:
        if ln.startswith("## "):
            in_props = ln.lower().startswith("## props")
            continue
        if not in_props:
            continue
        if not ln.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        head = cells[0].lower()
        # Skip the header + separator rows.
        if head in ("prop", "") or set(cells[0]) <= set("-: "):
            continue
        name = re.sub(r"[`*]", "", cells[0]).strip()
        kind = cells[1] if len(cells) > 1 else ""
        notes = cells[2] if len(cells) > 2 else ""
        key = (name.lower(), notes.lower())
        if not name or key in seen:
            continue
        seen.add(key)
        rows.append({"name": name, "kind": kind, "notes": notes})
    return rows


def resolve_common_props() -> list[dict]:
    """Parse the ``### Common environment dressing`` table in the track-set
    README (``docs/tracks/README.md``).

    Each per-track doc lists only the props *unique* to that track; the
    reusable dressing kit (``scatter_rocks`` → rock, palms, gulls, haze) is
    documented once in the README and present on most tracks. Without this,
    ``resolve_props`` saw only the unique hero sculpt and every track's AI
    lane undercounted (sandbar resolved to zero). Returns the same
    ``{name, kind, notes}`` shape as :func:`resolve_props`, plus
    ``"common": True`` so callers can label provenance.

    The companion ``### Required gameplay / system objects`` table is
    deliberately NOT folded in — those are all VFX/gameplay objects that
    route to ``skip`` and would only add noise (and a couple, like the
    horizon ring / racer grid, would land in procedural / manual).

    Name extraction prefers the canonical backticked prop id when the cell
    has one (```scatter_rocks` / coral-debris`` → ``scatter_rocks``):
    a descriptive alternate like "coral-debris" would otherwise hijack
    routing, since ``coral`` matches the procedural foliage rule before the
    AI rock rule."""
    path = os.path.join(TRACK_DOCS, "README.md")
    if not os.path.isfile(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    rows: list[dict] = []
    seen: set = set()
    in_section = False
    for ln in lines:
        if ln.startswith("#"):
            in_section = ln.lstrip("#").strip().lower().startswith(
                "common environment dressing")
            continue
        if not in_section or not ln.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        if cells[0].lower() in ("prop", "") or set(cells[0]) <= set("-: "):
            continue
        m = re.search(r"`([^`]+)`", cells[0])
        name = m.group(1) if m else re.sub(r"[`*]", "", cells[0]).strip()
        kind = cells[1] if len(cells) > 1 else ""
        notes = cells[2] if len(cells) > 2 else ""
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        rows.append({"name": name, "kind": kind, "notes": notes, "common": True})
    return rows


def _norm(text: str) -> str:
    """Lower-case and treat ``_``/``-`` as spaces so snake_case prop names
    (``scatter_palms``) and the ``\\b`` word-boundary rules cooperate."""
    return re.sub(r"[_\-]+", " ", text.lower())


def _match_routes(hay: str):
    """First matching route, or None. Procedural rules precede AI rules in
    ROUTES, so a prop that is both (e.g. ``Rock arches`` — rock + arch)
    resolves to its limiting form (procedural arch)."""
    for pattern, action in ROUTES:
        if re.search(pattern, hay):
            return action
    return None


def classify(prop: dict) -> dict:
    """Route one resolved prop. Returns a dict with ``lane`` in
    {"ai", "procedural", "skip", "manual"} and lane-specific fields.

    The prop's NAME is its identity, so it is matched first; the notes are
    only consulted when the name carries no archetype signal. This stops a
    stray word in the notes (``scatter_rocks`` … "between arches") from
    hijacking a prop whose name is unambiguous."""
    name, kind, notes = prop["name"], prop["kind"], prop["notes"]

    if _SKIP_KIND.search(kind) or _SKIP_NAME.search(name.lower()):
        return {"lane": "skip", "reason": "gameplay/VFX object — not a mesh prop"}

    action = _match_routes(_norm(name)) or _match_routes(_norm(notes))
    if action is None:
        return {"lane": "manual",
                "reason": "no archetype matched — classify by hand (AI if compact/solid)"}
    if isinstance(action, tuple):                   # procedural
        return {"lane": "procedural", "reason": action[1]}
    fam = AI_FAMILIES[action]                        # AI family key
    # Unique families are per-source hero sculpts (one statue ≠ another), so
    # the id and the prompt subject both key off the actual prop name; shared
    # families collapse onto one reusable prop_id + generic subject.
    if fam.unique:
        clean = re.sub(r"[`*]|×\s*\d+", "", name).strip()
        prop_id = _slug(name)
        subject = f"{clean}, {fam.subject}"
    else:
        prop_id = fam.prop_id
        subject = fam.subject
    return {
        "lane": "ai", "family": action, "prop_id": prop_id,
        "subject": subject, "target_tris": fam.target_tris,
        "target_height": fam.target_height, "collider": fam.collider,
        "tint": fam.tint, "smooth": fam.smooth, "mat_family": fam.family,
        "catalog": fam.catalog,
    }


# ── Manifest (live run state + committed reproducibility anchor) ──────

def manifest_path(level: str) -> str:
    return os.path.join(MANIFEST_DIR, f"{level}.json")


def load_manifest(level: str) -> dict | None:
    p = manifest_path(level)
    if not os.path.isfile(p):
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save_manifest(level: str, data: dict) -> None:
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    with open(manifest_path(level), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _ai_prop_has_work(p: dict) -> bool:
    """True if an AI-prop manifest entry carries pipeline work worth keeping
    across a re-plan: any artifact (concept / mesh / conditioned GLB /
    integrated library .blend) or an explicit approval decision. A plan-only
    entry (resolved but never worked) returns False — it's free to drop and
    re-resolve from scratch."""
    return bool(
        p.get("concept") or p.get("mesh") or p.get("conditioned_glb")
        or p.get("library_blend") or p.get("integrated")
        or p.get("approved") is not None)


def build_manifest(level: str) -> dict:
    """Resolve + route the level and (re)build its manifest, preserving any
    prior approval/seed/state for props that still exist.

    AI output isn't reproducible (docs/ai-prop-pipeline.md), so a prior AI
    prop that no longer resolves from the docs but has real work done is
    *preserved* as an orphan rather than silently dropped — losing it would
    lose its conditioned GLB / library .blend / prompt pointers. See the
    orphan pass at the end."""
    prior = load_manifest(level) or {}
    prior_props = {p["prop_id"]: p for p in prior.get("ai_props", [])}

    resolved = resolve_props(level)
    # Fold in the shared dressing kit from the track-set README so each
    # track's AI lane reflects the reusable props it actually uses (e.g.
    # scatter_rocks → sea_boulder), not just its one unique hero sculpt.
    # Only the AI-routable common props are folded — procedural common props
    # (palms) and VFX/gameplay objects stay reported via the per-track tables
    # exactly as before, so palm/gull/haze behaviour is unchanged. Appended
    # AFTER the per-track props so a track's own, more specific row wins any
    # dedup.
    common_ai = [p for p in resolve_common_props() if classify(p)["lane"] == "ai"]

    ai: dict[str, dict] = {}
    procedural: list[dict] = []
    manual: list[dict] = []

    for prop in resolved + common_ai:
        r = classify(prop)
        if r["lane"] == "skip":
            continue
        if r["lane"] == "procedural":
            procedural.append({"name": prop["name"], "reason": r["reason"],
                               "notes": prop["notes"]})
        elif r["lane"] == "manual":
            manual.append({"name": prop["name"], "reason": r["reason"],
                           "notes": prop["notes"]})
        else:  # ai — dedupe by prop_id, accumulate source names
            pid = r["prop_id"]
            # Label common-dressing provenance so the summary distinguishes a
            # shared-kit source from a track's own unique prop.
            src = prop["name"] + (" (common dressing)" if prop.get("common") else "")
            if pid in ai:
                if src not in ai[pid]["sources"]:
                    ai[pid]["sources"].append(src)
                continue
            prev = prior_props.get(pid, {})
            entry = {
                "prop_id": pid, "family": r["family"],
                "subject": r["subject"], "prompt": PROMPT_RECIPE.format(subject=r["subject"]),
                "target_tris": r["target_tris"], "target_height": r["target_height"],
                "collider": r["collider"], "tint": r["tint"],
                "smooth": r["smooth"], "mat_family": r["mat_family"],
                "catalog": r["catalog"], "sources": [src],
                # Run state (preserved across re-plan):
                "seed": prev.get("seed", 12345),
                "approved": prev.get("approved"),       # None=pending, True, False
                "concept": prev.get("concept"),
                "mesh": prev.get("mesh"),
                "conditioned_glb": prev.get("conditioned_glb"),
                "integrated": prev.get("integrated", False),
                "library_blend": prev.get("library_blend"),
            }
            ai[pid] = entry

    # Orphan pass: keep prior AI props that no longer resolve from the docs
    # but carry real work (the sandbar vertical slice hand-seeded several
    # props beyond its doc; a re-plan must not wipe them). Plan-only stale
    # entries are dropped. Orphans are tagged so the summary flags them and a
    # later re-appearance in the docs rebuilds them fresh (the tag is not
    # copied onto a resolved entry).
    orphans = [
        {**prev, "orphan": True}
        for pid, prev in prior_props.items()
        if pid not in ai and _ai_prop_has_work(prev)
    ]

    return {
        "level": level,
        "ai_props": list(ai.values()) + orphans,
        "procedural_lane": procedural,
        "manual_review": manual,
    }


# ── HTTP helpers ─────────────────────────────────────────────────────

def _http_get(url: str, timeout: int = 30) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def _http_post(url: str, payload: dict, timeout: int = 60) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body.decode("utf-8", "replace")}


def _port_alive(url: str, path: str, timeout: int = 4) -> bool:
    try:
        with urllib.request.urlopen(f"{url}{path}", timeout=timeout) as r:
            return 200 <= r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500            # a 4xx still means the server answered
    except Exception:
        return False


# ── ComfyUI server control (Phase A) ─────────────────────────────────

def comfy_alive() -> bool:
    return _port_alive(COMFY_URL, "/object_info/CheckpointLoaderSimple")


def comfy_up(timeout_s: int = 180) -> None:
    """Ensure ComfyUI is serving SDXL; start it if not."""
    if comfy_alive():
        print(f"[make-props] ComfyUI already up at {COMFY_URL}")
        return
    main_py = os.path.join(COMFY_DIR, "main.py")
    if not os.path.isfile(main_py):
        raise SystemExit(f"[make-props] ComfyUI main.py not found: {main_py}")
    print(f"[make-props] starting ComfyUI ({COMFY_PY} main.py --port 8188)…")
    _spawn_detached([COMFY_PY, "main.py", "--port", "8188"], cwd=COMFY_DIR)
    _wait_until(comfy_alive, timeout_s, "ComfyUI")


def comfy_idle() -> bool:
    """True when ComfyUI has nothing running or queued. ``/free`` returns
    400 while a job is still active (the unload would race the sampler), so
    we wait for the queue to drain before asking it to unload."""
    try:
        q = json.loads(_http_get(f"{COMFY_URL}/queue", timeout=10))
        return not q.get("queue_running") and not q.get("queue_pending")
    except Exception:                                      # noqa: BLE001
        return True            # no queue endpoint → assume idle, let /free try


def comfy_free() -> None:
    """Unload SDXL from VRAM so Hunyuan can load (the 8 GB handoff).

    Primary path is the documented ``POST /free`` (keeps the server up so a
    re-run's Phase A doesn't pay the restart cost). ``/free`` won't unload
    mid-job, so we wait for idle and retry. If it still can't free (older
    build, wedged queue), we FALL BACK to stopping the ComfyUI process — on
    an 8 GB box a guaranteed VRAM release matters more than keeping the
    server warm, and the next Phase A restarts it cleanly."""
    if not comfy_alive():
        return
    last = "unknown"
    for _ in range(6):
        if comfy_idle():
            try:
                _http_post(f"{COMFY_URL}/free",
                           {"unload_models": True, "free_memory": True}, timeout=30)
                print("[make-props] freed ComfyUI VRAM (POST /free)")
                return
            except Exception as e:                         # noqa: BLE001
                last = repr(e)
        else:
            last = "ComfyUI still busy"
        time.sleep(5)
    print(f"[make-props] /free didn't take ({last}); stopping ComfyUI to "
          f"guarantee the VRAM handoff")
    comfy_stop()


def comfy_stop() -> None:
    """Stop the process holding :8188 — the guaranteed-release fallback when
    /free won't take. Mirrors hunyuan_stop()."""
    _stop_port(8188, "ComfyUI")


# ── Hunyuan server control (Phase B) ─────────────────────────────────

def hunyuan_alive() -> bool:
    return _port_alive(HUNYUAN_URL, "/openapi.json")


def hunyuan_stop() -> None:
    """Kill the process holding :8080. Hunyuan has no /free endpoint, so the
    only way to reclaim its ~6 GB is to stop the process."""
    _stop_port(8080, "Hunyuan")


def _stop_port(port: int, name: str) -> None:
    """Kill whatever process is listening on ``port`` and wait for the port
    to free. Windows-first via PowerShell Get-NetTCPConnection; falls back
    to lsof on POSIX. The reclaim-VRAM-by-stopping primitive shared by the
    Hunyuan stop and the ComfyUI /free fallback."""
    if not _port_listening(port):
        return
    print(f"[make-props] stopping {name} (:{port}) to free VRAM…")
    if sys.platform == "win32":
        ps = (
            f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen "
            "-ErrorAction SilentlyContinue; "
            "$c.OwningProcess | Select-Object -Unique | "
            "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False)
    else:
        try:
            out = subprocess.check_output(["lsof", "-ti", f"tcp:{port}"]).decode()
            for pid in out.split():
                subprocess.run(["kill", "-9", pid], check=False)
        except Exception:                                  # noqa: BLE001
            pass
    for _ in range(30):                  # wait for the port to actually free
        if not _port_listening(port):
            return
        time.sleep(1)


def hunyuan_up(timeout_s: int = 240) -> None:
    """Start Hunyuan (must cd into the repo — gradio_cache is cwd-relative)
    and poll /openapi.json until the model is loaded (~60 s)."""
    if hunyuan_alive():
        print(f"[make-props] Hunyuan already up at {HUNYUAN_URL}")
        return
    api = os.path.join(HUNYUAN_DIR, "api_server.py")
    if not os.path.isfile(api):
        raise SystemExit(f"[make-props] Hunyuan api_server.py not found: {api}")
    print(f"[make-props] starting Hunyuan ({HUNYUAN_PY} api_server.py --port 8080)…")
    _spawn_detached([HUNYUAN_PY, "api_server.py", "--port", "8080"], cwd=HUNYUAN_DIR)
    _wait_until(hunyuan_alive, timeout_s, "Hunyuan (model load ~60 s)")


# ── Process helpers ──────────────────────────────────────────────────

def _spawn_detached(cmd: list[str], cwd: str) -> None:
    """Launch a long-lived server detached so it outlives this CLI call.

    Logs go to <RUN_DIR>/servers/<exe>.log so a failed start is debuggable."""
    os.makedirs(os.path.join(RUN_DIR, "servers"), exist_ok=True)
    log = os.path.join(RUN_DIR, "servers",
                       os.path.splitext(os.path.basename(cmd[0]))[0] + ".log")
    logf = open(log, "ab")
    kwargs: dict = {"cwd": cwd, "stdout": logf, "stderr": logf, "stdin": subprocess.DEVNULL}
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008)   # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, **kwargs)


def _port_listening(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _wait_until(pred, timeout_s: int, what: str) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if pred():
            print(f"[make-props] {what} ready ({int(time.time() - t0)} s)")
            return
        time.sleep(3)
    raise SystemExit(f"[make-props] timed out waiting for {what} ({timeout_s} s)")


# ── Phase A: concepts ────────────────────────────────────────────────

def _run_dir(level: str, *parts: str) -> str:
    d = os.path.join(RUN_DIR, level, *parts)
    return d


def _concept_dir(level: str) -> str:
    """Per-level concept-art folder in the content root (Drive-backed)."""
    return os.path.join(CONCEPT_ART_DIR, level)


def _abs_content(rel: str) -> str:
    """Resolve a manifest pointer stored relative to the content root. Tolerates
    an already-absolute value (legacy manifests / overrides)."""
    return rel if os.path.isabs(rel) else os.path.join(CONTENT_ROOT, rel)


def _pending_for_concepts(m: dict, only: set | None) -> list[dict]:
    out = []
    for p in m["ai_props"]:
        if only is not None and p["prop_id"] not in only:
            continue
        if only is None and p.get("concept") and p.get("approved") is not False:
            continue                    # already have a concept; don't redo
        out.append(p)
    return out


def cmd_concepts(level: str, only: set | None) -> None:
    from tools import comfyui_gen
    m = load_manifest(level) or build_manifest(level)
    targets = _pending_for_concepts(m, only)
    if not targets:
        print("[make-props] no concepts to generate (all present; use --only to force)")
        return

    hunyuan_stop()                       # SDXL and Hunyuan can't coexist in 8 GB
    comfy_up()

    cdir = _concept_dir(level)           # <content-root>/concept-art/props/<level>
    os.makedirs(cdir, exist_ok=True)
    for p in targets:
        out = os.path.join(cdir, f"{p['prop_id']}.png")
        print(f"[make-props] concept: {p['prop_id']}  seed={p['seed']}")
        # `negative` is optional per-prop (committed alongside the prompt as
        # part of the reproducibility anchor). When absent, comfyui_gen falls
        # back to its default clean-cutout negative, so other levels' manifests
        # are unaffected.
        neg = p.get("negative")
        if neg:
            comfyui_gen.generate(p["prompt"], out, seed=int(p["seed"]), neg=neg)
        else:
            comfyui_gen.generate(p["prompt"], out, seed=int(p["seed"]))
        # Store relative to the content root — keeps the committed manifest
        # portable (no machine-specific C:\Users\… paths).
        p["concept"] = os.path.relpath(out, CONTENT_ROOT)
        if p.get("approved") is None:
            p["approved"] = None         # leave pending for the review gate
    save_manifest(level, m)
    sheet = write_contact_sheet(level, m)
    print("\n[make-props] Phase A complete. REVIEW GATE:")
    print(f"    open {sheet}")
    print(f"    then: approve/reject/regen, e.g.")
    print(f"      python tools/make_level_props.py {level} approve <id> [<id>…]")
    print(f"      python tools/make_level_props.py {level} regen <id> [--subject \"…\"]")


def write_contact_sheet(level: str, m: dict) -> str:
    """One HTML page: every concept with its id, prompt, and approval state.
    Dependency-free (no PIL); opens in any browser — the one review surface."""
    cards = []
    for p in m["ai_props"]:
        concept = p.get("concept")
        # Sheet is co-located with the PNGs in the concept-art folder, so the
        # image is referenced by bare filename.
        img = (f'<img src="{os.path.basename(concept)}">'
               if concept else '<div class="missing">— no concept —</div>')
        state = {True: "approved", False: "rejected", None: "pending"}[p.get("approved")]
        srcs = ", ".join(p.get("sources", []))
        cards.append(f"""
        <div class="card {state}">
          <div class="thumb">{img}</div>
          <div class="meta">
            <h3>{p['prop_id']} <span class="badge">{state}</span></h3>
            <p class="srcs">from: {srcs}</p>
            <p class="prompt">{p.get('prompt', '')}</p>
            <p class="params">family={p.get('family', '?')} · tris={p.get('target_tris', '?')} ·
               height={p.get('target_height', '?')}m · collider={p.get('collider', '?')} ·
               smooth={p.get('smooth', '?')} · seed={p.get('seed', '?')}</p>
          </div>
        </div>""")
    html = f"""<!doctype html><meta charset="utf-8">
<title>make-level-props — {level} concepts</title>
<style>
  body{{font:14px system-ui;margin:24px;background:#111;color:#eee}}
  h1{{font-size:20px}} .grid{{display:grid;gap:16px;
    grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}}
  .card{{border:2px solid #333;border-radius:8px;overflow:hidden;background:#1b1b1b}}
  .card.approved{{border-color:#3a7}} .card.rejected{{border-color:#a33;opacity:.55}}
  .card.pending{{border-color:#aa3}}
  .thumb img{{width:100%;display:block}} .thumb .missing{{padding:48px;text-align:center;color:#888}}
  .meta{{padding:10px 12px}} h3{{margin:.2em 0;font-size:15px}}
  .badge{{font-size:11px;padding:1px 6px;border-radius:4px;background:#333}}
  .srcs{{color:#9bd;margin:.2em 0}} .prompt{{color:#bbb;font-size:12px}}
  .params{{color:#888;font-size:11px}}
</style>
<h1>{level} — {len([p for p in m['ai_props'] if p.get('concept')])}/{len(m['ai_props'])} concepts ·
   approve with the CLI, this page reflects the manifest</h1>
<div class="grid">{''.join(cards)}</div>
"""
    out = os.path.join(_concept_dir(level), "_contact_sheet.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    return out


# ── Review-gate commands ─────────────────────────────────────────────

def _set_approval(level: str, ids: list[str], value) -> None:
    m = load_manifest(level)
    if not m:
        raise SystemExit("[make-props] no manifest — run `plan`/`concepts` first")
    known = {p["prop_id"] for p in m["ai_props"]}
    for pid in ids:
        if pid not in known:
            raise SystemExit(f"[make-props] unknown prop_id {pid!r} (have: {sorted(known)})")
    for p in m["ai_props"]:
        if p["prop_id"] in ids:
            p["approved"] = value
    save_manifest(level, m)
    verb = {True: "approved", False: "rejected"}[value]
    print(f"[make-props] {verb}: {', '.join(ids)}")
    write_contact_sheet(level, m)


def cmd_regen(level: str, pid: str, subject: str | None) -> None:
    """Re-roll one concept: bump the seed (and optionally retarget the
    subject), regenerate it, leave it pending for re-review."""
    m = load_manifest(level)
    if not m:
        raise SystemExit("[make-props] no manifest — run `concepts` first")
    p = next((x for x in m["ai_props"] if x["prop_id"] == pid), None)
    if p is None:
        raise SystemExit(f"[make-props] unknown prop_id {pid!r}")
    p["seed"] = int(p.get("seed", 12345)) + 1
    if subject:
        p["subject"] = subject
        p["prompt"] = PROMPT_RECIPE.format(subject=subject)
    p["approved"] = None
    save_manifest(level, m)
    cmd_concepts(level, only={pid})


# ── Phase B: mesh ────────────────────────────────────────────────────

def _approved_with_concepts(m: dict, only: set | None) -> list[dict]:
    out = []
    for p in m["ai_props"]:
        if only is not None and p["prop_id"] not in only:
            continue
        if p.get("approved") is True and p.get("concept"):
            out.append(p)
    return out


def cmd_mesh(level: str, only: set | None) -> None:
    m = load_manifest(level)
    if not m:
        raise SystemExit("[make-props] no manifest — run `concepts`+approve first")
    targets = _approved_with_concepts(m, only)
    if not targets:
        raise SystemExit("[make-props] nothing approved with a concept — approve first")

    comfy_free()                         # hand VRAM to Hunyuan
    hunyuan_up()

    mdir = _run_dir(level, "meshes")
    os.makedirs(mdir, exist_ok=True)
    for p in targets:
        png = _abs_content(p["concept"])   # content-art folder (Drive-backed)
        out = os.path.join(mdir, f"{p['prop_id']}.glb")
        print(f"[make-props] mesh: {p['prop_id']} (Hunyuan image→3D)")
        _hunyuan_mesh(png, out)
        p["mesh"] = os.path.relpath(out, REPO_ROOT)
        save_manifest(level, m)
    hunyuan_stop()                       # free VRAM for Blender (Phase C)
    print("\n[make-props] Phase B complete. Next: `condition`.")


def _hunyuan_mesh(png_path: str, out_glb: str, *, poll_s: int = 600) -> None:
    with open(png_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    resp = _http_post(f"{HUNYUAN_URL}/send", {
        "image": b64, "octree_resolution": 256, "num_inference_steps": 20,
        "guidance_scale": 5.5, "texture": False,        # shape-only — VRAM ~6 GB
    }, timeout=60)
    uid = resp.get("uid") or resp.get("token") or resp.get("id")
    if not uid:
        raise SystemExit(f"[make-props] Hunyuan /send gave no uid: {resp}")
    t0 = time.time()
    while time.time() - t0 < poll_s:
        status = json.loads(_http_get(f"{HUNYUAN_URL}/status/{uid}", timeout=60))
        s = status.get("status")
        if s == "completed":
            glb_b64 = status.get("model_base64") or status.get("model")
            if not glb_b64:
                raise SystemExit(f"[make-props] Hunyuan completed without model: {status.keys()}")
            with open(out_glb, "wb") as f:
                f.write(base64.b64decode(glb_b64))
            return
        if s in ("error", "failed"):
            raise SystemExit(f"[make-props] Hunyuan failed: {status}")
        time.sleep(3)
    raise SystemExit(f"[make-props] Hunyuan timed out on {os.path.basename(out_glb)}")


# ── Phase C: condition ───────────────────────────────────────────────

def cmd_condition(level: str, only: set | None) -> None:
    m = load_manifest(level)
    if not m:
        raise SystemExit("[make-props] no manifest")
    targets = [p for p in m["ai_props"]
               if p.get("mesh") and (only is None or p["prop_id"] in only)]
    if not targets:
        raise SystemExit("[make-props] no meshed props to condition — run `mesh` first")

    hunyuan_stop()                       # ensure VRAM is free for Blender
    os.makedirs(ASSET_DIR, exist_ok=True)
    spec = []
    for p in targets:
        out = os.path.join(ASSET_DIR, f"{p['prop_id']}.glb")
        spec.append({
            "input": os.path.join(REPO_ROOT, p["mesh"]),
            "prop_id": p["prop_id"], "family": p["mat_family"],
            "target_tris": p["target_tris"], "target_height": p["target_height"],
            "collider": p["collider"], "tint": p["tint"], "smooth": p["smooth"],
            "output": out,
        })
    _run_blender("condition_ai_batch.py", spec, level, "condition")
    for p in targets:
        p["conditioned_glb"] = os.path.relpath(
            os.path.join(ASSET_DIR, f"{p['prop_id']}.glb"), REPO_ROOT)
    save_manifest(level, m)
    print("\n[make-props] Phase C complete. REVIEW GATE before integrating:")
    print("    eyeball the conditioned GLBs (e.g. ?viewer=<id> in a headed/WebGPU browser):")
    for p in targets:
        print(f"      {p['conditioned_glb']}")
    print(f"    then: python tools/make_level_props.py {level} integrate")


# ── Integrate ────────────────────────────────────────────────────────

def cmd_integrate(level: str, only: set | None) -> None:
    m = load_manifest(level)
    if not m:
        raise SystemExit("[make-props] no manifest")
    targets = [p for p in m["ai_props"]
               if p.get("conditioned_glb") and p.get("approved") is True
               and (only is None or p["prop_id"] in only)]
    if not targets:
        raise SystemExit(
            "[make-props] nothing approved+conditioned to integrate — "
            "run `condition` and ensure props are approved")

    os.makedirs(LIB_BLEND_DIR, exist_ok=True)
    spec = []
    for p in targets:
        spec.append({
            "input": os.path.join(REPO_ROOT, p["mesh"]),  # re-condition from raw
            "prop_id": p["prop_id"], "family": p["mat_family"],
            "target_tris": p["target_tris"], "target_height": p["target_height"],
            "collider": p["collider"], "tint": p["tint"], "smooth": p["smooth"],
            "catalog": p["catalog"],
            "output": os.path.join(LIB_BLEND_DIR, f"{p['prop_id']}.blend"),
        })
    _run_blender("integrate_ai_props.py", spec, level, "integrate")
    for p in targets:
        p["integrated"] = True
        # Stored relative to the content root (same as `concept`) so the
        # committed manifest stays portable; the file itself lives outside
        # the repo, in the Drive-synced content root.
        p["library_blend"] = os.path.relpath(
            os.path.join(LIB_BLEND_DIR, f"{p['prop_id']}.blend"), CONTENT_ROOT)
    save_manifest(level, m)
    print(f"\n[make-props] integrated {len(targets)} prop(s) — one .blend each "
          f"in the content root (raw sources, out of git):")
    print(f"      {LIB_BLEND_DIR}")
    print("    They appear next to the procedural props in the Asset Browser")
    print("    (the content root's tracks-src/ is the registered asset library).")
    print("    The committed (in-repo) source of truth is the exported GLB:")
    for p in targets:
        print(f"      {p['conditioned_glb']}  (+ prompt in specs/props/ai/{level}.json)")
    print("    Commit those (Git LFS) so the AI output is reproducible.")


def _run_blender(script: str, spec: list, level: str, phase: str) -> None:
    blender = resolve_blender()
    script_path = os.path.join(REPO_ROOT, "tools", "blender", script)
    spec_path = _run_dir(level, f"_{phase}_spec.json")
    os.makedirs(os.path.dirname(spec_path), exist_ok=True)
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2)
    print(f"[make-props] Blender {phase}: {len(spec)} prop(s)…")
    res = subprocess.run(
        [blender, "--background", "--python", script_path, "--", "--spec", spec_path],
        cwd=REPO_ROOT)
    if res.returncode != 0:
        raise SystemExit(f"[make-props] Blender {phase} failed (exit {res.returncode})")


# ── plan / summary ───────────────────────────────────────────────────

def cmd_plan(level: str) -> None:
    m = build_manifest(level)
    save_manifest(level, m)
    print_summary(m)
    print(f"\n[make-props] manifest written → "
          f"{os.path.relpath(manifest_path(level), REPO_ROOT)}")
    print(f"[make-props] next: python tools/make_level_props.py {level} concepts")


def print_summary(m: dict) -> None:
    level = m["level"]
    ai, proc, man = m["ai_props"], m["procedural_lane"], m["manual_review"]
    resolved_ai = [p for p in ai if not p.get("orphan")]
    orphan_ai = [p for p in ai if p.get("orphan")]
    st_of = {True: "✓approved", False: "✗rejected", None: "·pending"}
    print(f"\n══ make-level-props: {level} ══")
    print(f"\n  AI lane ({len(resolved_ai)} props — compact/solid → ComfyUI→Hunyuan→condition):")
    for p in resolved_ai:
        print(f"    • {p['prop_id']:<16} {st_of[p.get('approved')]:<10} ← {', '.join(p['sources'])}")
    if orphan_ai:
        print(f"\n  AI lane — orphaned ({len(orphan_ai)} kept; no longer in the track "
              f"doc, preserved for their GLB/prompt):")
        for p in orphan_ai:
            print(f"    • {p['prop_id']:<16} {st_of[p.get('approved')]:<10} "
                  f"← {', '.join(p.get('sources', []))}")
    print(f"\n  Procedural lane ({len(proc)} — thin/spanning/bespoke, NOT for GPU):")
    for p in proc:
        print(f"    • {p['name']}\n        ↳ {p['reason']}")
    if man:
        print(f"\n  Manual review ({len(man)} — no archetype matched):")
        for p in man:
            print(f"    • {p['name']} — {p['notes']}\n        ↳ {p['reason']}")


# ── CLI ──────────────────────────────────────────────────────────────

def _only(args) -> set | None:
    return set(args.only.split(",")) if getattr(args, "only", None) else None


def main(argv: list[str] | None = None) -> None:
    # The console output uses box-drawing / bullet glyphs; Windows' default
    # cp1252 stdout chokes on them. Force UTF-8 (replace on any holdout).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.path.insert(0, REPO_ROOT)        # so `from tools import comfyui_gen` works
    ap = argparse.ArgumentParser(
        prog="make-level-props",
        description="Orchestrate the local AI prop pipeline over a whole level.")
    ap.add_argument("level", help="track id, e.g. the-maw (see docs/tracks/)")
    sub = ap.add_subparsers(dest="phase", required=False)

    sub.add_parser("plan", help="resolve + route the level's prop list")
    sp = sub.add_parser("concepts", help="Phase A: generate all concept images (ComfyUI)")
    sp.add_argument("--only", help="comma-separated prop_ids to (re)generate")
    sa = sub.add_parser("approve", help="mark concept(s) approved for meshing")
    sa.add_argument("ids", nargs="+")
    sr = sub.add_parser("reject", help="mark concept(s) rejected")
    sr.add_argument("ids", nargs="+")
    sg = sub.add_parser("regen", help="re-roll one concept (bump seed / retarget)")
    sg.add_argument("id")
    sg.add_argument("--subject", help="override the prompt subject")
    sm = sub.add_parser("mesh", help="Phase B: mesh approved concepts (Hunyuan)")
    sm.add_argument("--only", help="comma-separated prop_ids")
    sc = sub.add_parser("condition", help="Phase C: condition meshes → prop_<id> GLB")
    sc.add_argument("--only", help="comma-separated prop_ids")
    si = sub.add_parser("integrate", help="append + hv_lock conditioned props into the library")
    si.add_argument("--only", help="comma-separated prop_ids")
    sub.add_parser("status", help="show the current manifest summary")

    args = ap.parse_args(argv)
    level = args.level
    phase = args.phase or "plan"

    if phase == "plan":
        cmd_plan(level)
    elif phase == "status":
        m = load_manifest(level) or build_manifest(level)
        print_summary(m)
    elif phase == "concepts":
        cmd_concepts(level, _only(args))
    elif phase == "approve":
        _set_approval(level, args.ids, True)
    elif phase == "reject":
        _set_approval(level, args.ids, False)
    elif phase == "regen":
        cmd_regen(level, args.id, args.subject)
    elif phase == "mesh":
        cmd_mesh(level, _only(args))
    elif phase == "condition":
        cmd_condition(level, _only(args))
    elif phase == "integrate":
        cmd_integrate(level, _only(args))


if __name__ == "__main__":
    main()
