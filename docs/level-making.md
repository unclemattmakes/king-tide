# Making a level — start here

The single entry point for **building a track**. If you've just joined the project and
your job is to make levels, read this page first, then follow the reading order below.
It tells you *which* of the dozen level docs to read, *in what order*, and *which apply
to you* (a human in Blender's N-panel vs. an agent driving Blender over MCP).

> **TL;DR for your very first track:** open the published walkthrough
> [**Your first track**](../docs-site/blender/your-first-track.md) (blank Blender scene
> → playable map in ~20 min), then come back here for the content pass, the art pass,
> and gameplay tuning.

---

## What a "track" actually is

A track is **three artifacts**, all keyed by a lowercase-dash **slug** (e.g. `sandbar`):

| Artifact | Path | Authored in | Committed? |
|---|---|---|---|
| Environment geometry | `public/assets/tracks/<slug>.glb` | Blender (exported) | no — on R2/Drive, `pnpm assets:pull` |
| Gameplay data | `public/tracks/<slug>.json` | Blender export **and/or** the in-app editor | **yes** |
| Source scene | `tracks-src/<slug>.blend` | Blender | no — gitignored (see [below](#where-the-blend-lives)) |

The slug is the URL: `tracks-src/sandbar.blend` → `public/...sandbar.glb` +
`public/tracks/sandbar.json` → plays at `http://localhost:5191/?track=sandbar`.

> **Display name vs. slug.** Slugs are forever; display names change. **Mayday Bay** is
> the slug `sandbar`; **Mexico City** is the slug `mexico-city` (formerly "Texcoco
> Rising"). Don't rename a slug to match a display-name change.

---

## The pipeline, end to end

```
 shape ─▶ terrain ─▶ racing line ─▶ start grid ─▶ water/sky ─▶ EXPORT ─▶ playable greybox
   │                                                                          │
   └────────────────────────── (iterate) ────────────────────────────────────┤
                                                                              ▼
                              content pass (in-track + out-of-track props, wave zones)
                                                                              │
                                                                              ▼
                              art pass (dress with props/foliage/waterline/grade)
                                                                              │
                                                                              ▼
                              gameplay tuning (gates, pickups, boosts — in-app editor)
                                                                              ▼
                                                                            SHIP
```

You don't have to go strictly in order — but get to **playable greybox** before you
dress anything, and **playtest between passes**. The owner's hands-on playtest is the
real look/feel check, not any render or analysis.

---

## Two authoring workflows (you'll use both)

A track's data has two homes, bridged by the [export ownership contract](#the-export-ownership-contract):

- **All-in-Blender** — author the spline, start grid, gate spacing, water and sky in
  Blender; **Export Track to Game** derives the JSON. This is the fastest "blank scene
  → playable" path, and what [Your first track](../docs-site/blender/your-first-track.md)
  and the [level-design playbook](./level-design-playbook.md) teach.
- **Hybrid** — keep the `.blend` focused on collidable **environment geometry**, and
  author/iterate the **placement gameplay** (gate positions, pickups, boost pads, props,
  prop-lines) in the in-app editor (`?track=<slug>&edit=1`), which saves straight to
  `public/tracks/<slug>.json`. Much faster iteration than re-exporting from Blender for
  every gate move — preferred once the geometry is settled
  ([track-editor-guide](./track-editor-guide.md)).

They compose because **export merges rather than stomps**.

### The export ownership contract

`Export Track to Game` re-derives some JSON keys from the `.blend` and **preserves**
the rest. Get this wrong and you lose work, so internalize it:

- **Blender owns** (re-export **overwrites** these): `id`, `name`, `environmentGlb`,
  `water`, `terrainShader`, `sky`, `aiSplines`, `gateSpacing`, `floatGates`,
  `lapsToFinish`, `start`, `waveRiderBuoys`, `roadSpline`.
- **The editor owns** (preserved across re-exports): `checkpoints` (hand-placed gates),
  `pickupSpawns`, `boostPads`, `props`, `propLines`, `antiGravZones`, `waveZones`,
  `audio`.

> **The gotcha that bites everyone:** `aiSplines` is **Blender-owned**. If you nudge
> spline anchors in the in-app editor and then re-export from Blender, the Blender curve
> **overwrites** your editor edits. Rule of thumb: **shape the racing line in Blender**;
> use the editor for gate/pickup/boost/prop *placement*. (Gates work either way:
> `gateSpacing` auto-spaces them from Blender, or hand-place `cp` gates in the editor —
> hand-placed gates are editor-owned and survive re-export.)

The canonical key list lives in `tools/blender/kingtide_addon/_legacy.py`
(`BLENDER_OWNED_JSON_KEYS`); the `Track` type is in
[`src/game/tracks/types.ts`](../src/game/tracks/types.ts).

---

## Where the `.blend` lives

Save your track as **`tracks-src/<slug>.blend`**. The addon detects "track mode" purely
from the **`tracks-src/` folder name** — and that folder can be either:

- **inside your clone** (simplest — just save there), or
- a **Drive-synced `tracks-src/` outside the clone** (the team's setup; exports still
  land in the clone via the addon's *Project root* pref / `$KINGTIDE_REPO_ROOT`).

Either way the per-track `.blend` is **gitignored** — only the compiled
`public/assets/tracks/<slug>.glb` and `public/tracks/<slug>.json` are committed. Raw
`.blend` sources sync via `pnpm assets:pull` / `assets:push`
([asset-storage](./asset-storage.md)). To start from a template, use the addon's
**New Map from Template** (copies a `tracks-src/template-*.blend` to a fresh
`tracks-src/<slug>.blend`).

---

## Reading order

Read these in order; skip what doesn't apply to your stage.

1. **[Your first track](../docs-site/blender/your-first-track.md)** *(published
   walkthrough)* — blank scene → playable greybox, all in Blender's N-panel. Start here
   even if you'll later script it. Backed by the
   [Blender pipeline guide](./blender-pipeline-guide.md) (the exhaustive addon/operator
   reference) and the [scene conventions](../docs-site/blender/scene-conventions.md)
   (object names, `kind` extras, the coordinate swap).
2. **[Level-design playbook](./level-design-playbook.md)** — the full **content-pass
   workflow** (shape → terrain/landmarks → vertical → in-track props → out-of-track
   props → polish), the blocking-diagram technique, and the AI-corridor clearance rules.
   *(Note: this is written for an **agent driving Blender over MCP**; if you're a human
   in the N-panel, the operators map 1:1 to the addon buttons — see the playbook's tool
   cheat-sheet and the Blender pipeline guide.)*
3. **[`docs/tracks/README.md`](./tracks/README.md)** — the **canonical track lineup**
   and, for whichever track you're building, its per-track design doc + `-art-target`.
   This index supersedes the older bible/specs where they disagree.
4. **[Track art pass playbook](./track-art-pass-playbook.md)** + **[track art
   direction](./track-art-direction.md)** — how to **dress** a gameplay-complete track
   with props, foliage, waterline and grade without breaking gameplay or the source
   `.blend`. Pair with the canonical [art direction](./art-direction.md) (the
   painterly-vinyl visual language).
5. **[Track editor guide](./track-editor-guide.md)** — the in-app `?edit=1` editor:
   the fast loop for tuning gate / pickup / boost / prop placement straight into JSON.

Supporting references, pull in as needed:

- [Blender pipeline guide](./blender-pipeline-guide.md) — every panel/operator (terrain
  templates, road, tunnel, ramp, downtown, scatter/biome foliage, wave zones, emitters,
  horizon, sky, hero render, decals, gate buoys, export).
- [GeoNode toolkit](./geonode-toolkit.md) — the parametric Geometry-Nodes prop tools.
- [Asset pipeline guide](./asset-pipeline-guide.md) — the spec→GLB build for
  bikes/props/tracks and where everything lives.
- [Track themes](./track-themes.md) — the lore/content bible (read the top banner;
  `tracks/README.md` is canonical where they disagree).
- [Track design specs](./track-design-specs.md) — beat-by-beat timing, wave-zone and
  camera numbers per track.
- Props for your level: the [AI prop pipeline](./ai-prop-pipeline.md) +
  [props production plan](./props-production-plan.md), or the `/make-props` skill.

---

## House rules that prevent lost work

- **Open the concept art before you model.** MJ plates live under the content root's
  `concept-art/midjourney/<track>/best/`. Text design docs are *not* a substitute —
  building off text instead of the plates has cost full redos. Read the hero plate +
  the relevant beat plate **and** the [art direction](./art-direction.md) section first.
- **Judge the look in-engine, not in Blender clay.** Pastels, translucent water,
  waterline, neon glow and the horizon shader only read in the WebGPU renderer. Verify
  look + feel in a **headed Playwright run on your own dev server** (CLAUDE.md hard
  rule 2) — never the in-app preview or a shared tab.
- **Verify the artifact, not the render.** After export, parse the GLB (`kind` counts)
  and the JSON (gameplay keys) — that's the deterministic check.
- **Anti-grav is parked** (cut from races, kept for a possible DLC). No shipped track
  uses it; verticality comes from terrain, ramps, berms, and cliffs. Don't author
  anti-grav set-pieces.
- **`status: 'ship'` ≠ art-complete.** Only **Mayday Bay** (`sandbar`) and **The Maw**
  are dressed; the rest are greybox route-stubs awaiting the v2 art pass.

---

*Lost? The [README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md) point here;
[CLAUDE.md](../CLAUDE.md) is the terse index for the whole repo.*
