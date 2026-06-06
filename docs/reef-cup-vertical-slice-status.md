# Reef Cup — Vertical Slice Status & Path to Complete

> **Date:** 2026-06-05 · **Scope:** the three Reef Cup tracks —
> **Sandbar** (tutorial, technically "no cup" but ships in front of the Reef
> Cup as the classroom), **South Beach Sunken** (Reef #1), **Cape Town Drift**
> (Reef #2) — plus the cup shell that strings them together.
>
> **Purpose.** Document where each track stands **vs its design direction**
> ([docs/tracks/](tracks/README.md)) and **vs its art direction + concept-art
> target** ([track-art-direction.md](track-art-direction.md) +
> the per-track `*-art-target.md` distillations of the Midjourney pass), and
> lay out **what it takes to reach a complete vertical slice.**
>
> **How this was assessed (so the claims are checkable).** Design + art-target
> docs read in full; each `public/tracks/<id>.json` parsed for grade/water/
> props/checkpoints; each shipped `public/assets/tracks/<id>.glb` inventoried
> for node/material/vertex-attribute content; **in-engine WebGPU captures**
> taken under autopilot (`pnpm gen:track-shots sandbar,south-beach-sunken,cape-town-drift`
> → `test-results/track-shots/<id>/`, 16 frames each, real GPU) and read
> against the curated concept plates in
> `C:\project-content\hoverbike\concept-art\midjourney\<track>\best\`. Raw
> evidence is in the [Appendix](#appendix--evidence).

---

> **⚠️ Quality calibration (added after a craft audit).** Below, "built" /
> "in the GLB" means **exists and is wired** — it does **not** mean
> art-complete. A Blender-by-eye pass found most assets sit at **clean-blockout**
> quality (South Beach is 100% box-kitbash; Cape Town's freighter/harbour are
> crude boxes; the three hero set-pieces don't yet carry their postcard), with
> flat untextured materials throughout. For the **craft / AA-quality** gap and
> the asset-by-asset work catalog, see the companion
> **[reef-cup-art-quality-catalog.md](reef-cup-art-quality-catalog.md)**. This
> doc covers **wiring, playability, and render bugs**; that one covers **art
> quality**.

## TL;DR

The blocking pass did more than "block out." **All three tracks have their
gameplay loop, terrain, identity landmarks, and set-piece geometry built and
exported** — Cape Town's Table Mountain + Cape Wheel + aquarium are in the GLB;
South Beach's full Art-Deco hotel kit + Versace mansion + seaplane wing-ramp are
in the GLB. The slice is **not** blocked on "build the levels." It's blocked on
**making what's built read correctly in-engine, finishing the grade/water/
dressing, and proving the full 8-bike field completes each loop.**

| Track | Loop & geometry | Grade / water / sky | Dressing & set-piece legibility | Headline blocker | Est. to slice-complete |
|---|---|---|---|---|---|
| **Sandbar** | ✅ built (15 MB GLB, 8 gates, drivable) | ✅ **landing** — warm `venice_warm`, two-tone turquoise, waterline on | ⚠️ marina hub set-piece reads thin/muted; crest-launch dune unnamed | Marina props don't carry their tint (no COLOR_0) + framing | **~1–2 days** (polish) |
| **South Beach** | ✅ built (1.5 MB GLB, full Art-Deco kit + Versace + seaplane ramp) | ❌ sky preset chosen but **not graded** to sunset target; water choppy (Beaufort 4); waterline **off** | ❌ **buildings render dark** in-engine despite a colored material palette | **Dark-render bug** — colors aren't reaching the building masses | **~4–6 days** (diagnose + full grade/dress/wire) |
| **Cape Town** | ✅ built (2.7 MB GLB, all landmarks + set-pieces) | ✅ cool `cape_town_blue` + clouds **landing**; water needs a calm slalom zone | ⚠️ Table Mtn + Cape Wheel **present but not reading**; harbour detail is flat | Landmark legibility + weathering/rust pass; `timeOfDay:125` anomaly | **~3–4 days** (legibility + dress + wire) |

**The single highest-leverage finding:** a **vertex-color (`COLOR_0`) export
gap** runs through all three tracks. Only the `terrain_mesh` carries `COLOR_0`;
**every building/prop mesh ships without it** (South Beach 262/263 meshes
missing, Cape Town 25/26, Sandbar's 16 marina props). The capture log throws
30+ `THREE.AttributeNode: Vertex attribute "color" not found on geometry`
warnings. This (a) is the likely contributor to South Beach reading dark, (b)
means the **waterline trio + built/broken/blooming weathering can't reach any
building or prop** on any track (it's a vertex-color/`COLOR_0` job per
[art-direction.md](art-direction.md)), and (c) is a single pipeline fix that
lifts all three at once. **Fix the export first.**

---

## What "complete vertical slice" means here

This is a **content** slice, so the definition-of-done is the content analogue
of the [v1-work-breakdown DoD convention](v1-work-breakdown.md). A track is
slice-complete when **all** of these hold:

1. **Plays start-to-finish with the full 8-bike field** — no AI jam, gate
   reachable by the whole field (the recurring jam class: gates floating above
   raised terrain, or facing crosswise to the race line). Today only
   **single-bike autopilot** has been proven (the capture harness); 8-bike has
   not.
2. **Reads as its place at 40 m/s** — the identity landmark(s) sell the location
   in the first 3 seconds (Table Mountain, the Versace steps, the cove marina).
3. **Hits its art target** — grade/water/sky to the hero plate; the
   built/broken/blooming ratio reads; the **waterline trio** is on every passed
   shore; the hero **set-piece is built, lit, and legible.**
4. **Is dressed, not greyboxed** — JetMoto/Wave-Race edge density (props,
   foliage, emitters) with the racing line + ~6 m shoulder swept clean.
5. **The cup flows** — menu → 3 races → full-field standings → podium, with
   each track's sky/audio/roster wired. *(The cup shell itself already works —
   see [Cross-cutting](#cross-cutting-the-cup-shell).)*

Out of scope for *this* slice (tracked elsewhere, flagged so they're not
forgotten): **soundtrack licensing** (today's tracks are CC0 placeholders) and
the **wave-mastery legibility refit** (the "master the jump" pitch grading +
wave-pump chyron rework from [CLAUDE.md](../CLAUDE.md)). The slice should still
*exercise* wave-mastery — Sandbar's crest-launch + South Beach's wing-ramp are
where players first meet it — so its legibility is **slice-adjacent**, not
slice-internal.

---

## Cross-cutting findings (fix once, all three benefit)

### 1. The `COLOR_0` / vertex-color export gap — **P0, shared**
- **Evidence:** of all mesh primitives in the shipped GLBs, only `terrain_mesh`
  carries `COLOR_0`. South Beach: **1 of 263** primitives has it; Cape Town:
  **1 of 26**; Sandbar: 15 of 31 (terrain + main meshes yes, the 16 marina
  props no). The-maw (the art-dressed reference that looks right) has **40 of
  50**. Capture logs spam `Vertex attribute "color" not found`.
- **Why it matters:**
  - `mat_terrain_main` has **no `baseColorFactor`** (`base=none`) — it tints
    *entirely* from `COLOR_0`. Terrain is the one mesh that has it, so terrain
    is fine; everything that relies on vertex color for tint/weathering is not.
  - The **waterline trio** and the **built/broken/blooming weathering** are
    authored as a `COLOR_0`/decal job (per [art-direction.md](art-direction.md)).
    With no `COLOR_0` on buildings/props, **none of that reaches them** — which
    is why `terrainShader.waterline` only ever affects the terrain today.
  - It is **not** the cause of South Beach's dark render — that turned out to be
    **flipped normals** (confirmed by reading the GLB vertex normals; see that
    section). A missing `COLOR_0` fills vertex colour *white* in three.js, so it
    cannot darken a mesh. (The original draft of this doc guessed COLOR_0 here;
    that guess was wrong.)
- **Fix:** root-cause why the export drops `COLOR_0` on non-terrain meshes
  (addon vertex-color bake/stamp not running on building/prop collections, or
  the export config stripping it), re-export all three. One pipeline fix.

### 2. Waterline trio is terrain-only on every track — **P1, shared**
- `terrainShader.waterline` = `1` on Sandbar, **`0`** on South Beach and Cape
  Town. Even where it's on, it only marks the terrain (see #1). The art targets
  call for the trio (new-life fringe / crust / salt-bleach) on **every static
  surface crossing the sea line** — hotels, containers, pilings, the aquarium.
  Blocked behind #1.

### 3. Full-field (8-bike) completion is unproven — **P0, shared**
- The capture harness is single-bike autopilot. It completes all three loops
  (checkpoints advance, laps tick), but the **field-jam class** (gates floating
  above raised terrain; gates facing crosswise to the race line) has bitten this
  exact set before. Cape Town already needed an AI-jam pass (commit history).
  **Gate:** run an 8-bike race on each and confirm the whole field finishes.

### 4. Runtime props / emitters are absent on two of three — **P1**
> **✅ Largely resolved 2026-06-05 (Quaternius prop pass).** Placeholder boxes were
> swapped for library props across all three tracks (placed in Blender → `props[]`
> via the addon round-trip, verified in-engine). Counts now: **Sandbar 26**
> (cliffs/rocks/boats + `ai/pilot_shack`, replacing the marina-shack box) **+ 100
> buoys**; **Cape Town 135** (`cruise_ship` + 118 red containers + harbour
> houses/boats/crates, animated shark preserved); **South Beach 38** (2 wreck-boats
> + 36 lush palms). Re-exported GLBs need `pnpm assets:push`. Still open: emitters
> (gulls/motes/foam/signage glow), lounge chairs/flamingo, market stalls, the
> ferry-as-mover, and South Beach's hero hotels (modeling, not props). See
> [reef-cup-prop-replacement-catalog.md](reef-cup-prop-replacement-catalog.md). The
> original (pre-pass) state is preserved below for context.
- `props[]` in JSON: Sandbar **25** (AI boulders/wrecks/cab/anchor) + 100
  wave-rider buoys; South Beach **0**; Cape Town **0**. The unique-prop manifests
  call for gulls, palm-sway motes, seaplane heat-shimmer, container-rust,
  shark-tank foam, signage glow, lounge chairs, flamingo, market stalls, the
  tipped ferry as a mover, etc. Most are either runtime emitters or small props
  not yet placed. ("Alive" — a few moving things — is explicitly in every art
  target's build order.)

### 5. The cup shell (the connective tissue) — ✅ already works
- Reef Cup is re-cut to exactly these three with a stable rival roster,
  full-field standings on the MK8 points curve, post-race results board, and a
  3D podium ceremony (status.md 2026-06-05; `cup-progress.ts`,
  `podium-mode.ts`, pinned by tests). **No slice work needed on the shell** —
  only that each track's sky/roster/audio is wired (it is) and the three play
  through cleanly (gated by #3).

---

## Sandbar — *the classroom* (closest to done)

**Design intent** ([sandbar.md](tracks/sandbar.md)): a low-key 60 s scripted
tutorial cove, one lesson per beat, **pump taught in the first 8 s**, ending on
a **crest-launch** dune (the wave-mastery transfer lesson). Deliberately calm
and legible; no spectacle set-piece — the **pump HUD prompt** is the focal
moment.

**Art target** ([sandbar-art-target.md](tracks/sandbar-art-target.md), Reef
pastel **45 built / 15 broken / 40 blooming**): warm rose-peach mid-morning over
glassy turquoise shallows, a *cared-for* marina (repainted dock, cream/teal
pilot-school shack with hand-lettered signage + warm work-lights), near-zero
decay. The `marina_hub` plate is the one hero set-piece.

**Current state (evidence):**
- **Grade/water/sky: landing.** `venice_warm`, `cloudTowering 0.75`, `sunSize
  1.7`, `waterline 1`, Beaufort 1. In-engine the two-tone turquoise depth read
  and warm sky match the hero plate well (capture frames 00/05/15). This is the
  reference for how good the Reef-pastel water *can* look.
- **Geometry: built.** 15 MB GLB: terrain + 4 peaks, 12 cove palms, 6
  sea-stacks, the marina (deck/shack/roof/sign, pilings, bollards), `ramp_jump`,
  a dock. 25 placed AI props (18 sea-boulders, 3 rubble, 2 boat-wrecks, drowned
  cab, anchor) + 100 channel buoys. 8 gates, drivable.
- **Marina hero set-piece: under-reads.** The dock + anchor are visible (frame
  15) but the shack is tucked behind the palm shore and the timber reads
  thin/muted vs the vibrant `marina_hub` plate. Root causes: the marina props
  **lack `COLOR_0`** (see cross-cut #1) *and* the authored tints are dark
  (`mat_marina_shack` = `[0.03,0.21,0.26]` near-navy, `mat_marina_roof` =
  `[0.46,0.09,0.03]`) vs the bright blue/red concept. The art-target build-status
  already flagged this as a "rough first pass… wants a hands-on designer nudge."
- **Crest-launch dune: not a named set-piece.** GLB has `ramp_jump` but no
  `crest_berm`. The 42–55 s wave-mastery lesson — the most important beat for the
  slice's signature mechanic — may be merged into terrain or missing. **Verify.**

**Gap → tasks:**
- **P0** Re-export with `COLOR_0` on the marina props (cross-cut #1), so the
  shack/dock take tint + the waterline trio.
- **P1** Brighten + reframe the marina hub: push `mat_marina_shack`/`_roof` to
  the plate's bright blue/red; nudge shack/dock placement so the set-piece is
  visible from the start cove (designer pass, coords in the art-target).
- **P1** Confirm/author the **crest-launch dune** as a clean packed-sand lip
  against open sky (the wave-mastery lesson must be legible).
- **P2** Terrain `COLOR_0` bands read slightly muddy in the foreground — warm up
  the wet-sand→sand band. Add the `emitter_gulls` flock (deferred). Resolve the
  two pale triangular **horizon silhouettes** (frames 00/05) — confirm they read
  as distant dunes/islands, not stray mountains (off-theme for a fictional cove).
- **P2** Commit the **uncommitted racing-line re-layout** (`public/tracks/sandbar.json`
  has start + all checkpoints re-positioned, ~486-line churn, currently dirty in
  the working tree) once validated.

**Verdict:** ~80% to its art target. A polish track, not a build track.

---

## South Beach Sunken — *Reef #1* (most built, worst-rendering)

**Design intent** ([south-beach-sunken.md](tracks/south-beach-sunken.md)):
drowned Miami Beach, Art-Deco rooftops as a chain of pastel islands; 45 s lap ×
3; beats run Atlantic swell → **rooftop-chain weave** → **Versace Steps**
(seaplane wing-ramp big air) → inner-bay calm (pool-deck shortcut) → finish past
the lifeguard hut.

**Art target** ([south-beach-sunken-art-target.md](tracks/south-beach-sunken-art-target.md),
Reef pastel **45 / 15 / 40**): golden-hour **flamingo-pink sunset** over glassy
turquoise reef; "they kept the lights on" — kept-painted pastel hotels, neon-mint
signage, warm string-lights; the most defiantly-alive shoreline in the set. The
hero plates (`hero_aerial`, `versace_steps`) are lush and warm.

**Current state (evidence):**
- **Geometry: extensively built — far more than the frames suggest.** 1.5 MB GLB,
  **313 nodes / 252 meshes**: a full Art-Deco hotel kit (~10 buildings, each with
  mass + fins + awnings + crown + **neon** + stripe + windows + parapets), the
  **Versace Steps** set-piece (`sb_versace_step×5`, base/tier/tower), the
  **seaplane wing-ramp** (`sb_plane_wingramp`/`_fuse`/`_tail`/`_float`), the
  lifeguard hut (`sb_lg_hut`/`_roof`/`_rail`/`_leg`), 36 palms, 12 pilings,
  out-of-bounds skyline dressing (crane, billboard, ships), a `horizon_ring`, a
  `wave_zone` empty, and peaks. The material palette is complete and colored:
  `mat_track_sb_pink/mint/cream/butter/coral/...` + three **neon** emissives.
- **…but it renders DARK in-engine — CONFIRMED root cause: flipped (inward)
  normals.** Every capture frame shows the building masses as near-black slabs
  (terrain/sandbars read pale-tan correctly). Reading the GLB vertex normals,
  **every South Beach building/set-piece mesh points INWARD** — avg
  `normal·(outward dir)` ≈ **−0.27 to −0.46** on `sb_s0_mass`, `sb_versace_base`,
  `sb_plane_fuse`, `sb_plane_wingramp`, `sb_lg_hut`, `sb_s0_awn` — whereas Cape
  Town's and Sandbar's meshes point **outward** (+0.37 to +0.58). Under
  `MeshStandardMaterial` + default `FrontSide`, inward normals put the lit side
  away from the camera (`N·L < 0`) → no diffuse → ambient-only black. The whole
  box-kit shipped with inverted winding/normals (no negative scales — checked;
  inward winding baked into the geometry). It has **nothing to do with COLOR_0**;
  the colored `baseColorFactor`s are correct, they just never got lit.
  **✅ FIXED 2026-06-05** — recalculated-outside on 210 SB meshes + re-export;
  a posed in-engine WebGPU capture confirms the rooftop chain now renders
  cream/pastel with **glowing neon** signage.
- **Sky: preset chosen, not graded.** `miami_pastel` + `timeOfDay 0.85` are set,
  but `sunSize 1.1` / `cloudTowering 0.35` are at defaults (Sandbar uses
  `1.7`/`0.75`). In-engine the sky is a flat pale peach with a small high sun —
  not the dramatic flamingo-pink sunset with a big low sun the plates demand.
- **Water: wrong mood + no zoning.** Global `seaStateBeaufort 4` → choppy, vs the
  design's glassy reef shallows + calmer inner bay. `waveZones` is **empty** in
  JSON despite a `wave_zone` empty existing in the GLB — the per-beat calm/active
  zoning isn't wired.
- **Waterline `0`; runtime props/emitters `0`** (gulls, palm motes, seaplane
  heat-shimmer, signage glow, lounge chairs, flamingo all absent).

**Gap → tasks:**
- **P0 ✅ DONE (2026-06-05) — flipped normals fixed.** Recalculated-outside on
  **210** inward SB meshes (bmesh, net-inward only; terrain/foliage/horizon
  skipped), saved the `.blend`, re-exported through `hoverbike.export_track`
  (JSON merge preserved — empty `git diff`). GLB normals now **+0.46..+0.57
  outward**; posed in-engine capture shows the hotels rendering pastel + glowing
  neon. The hotels now show their pastel — the rest of the SB art pass can
  proceed on top of this.
- **P0** Full-field completion check (cross-cut #3) — this loop has the most
  structures to snag on.
- **P1** Grade the sky to the sunset target (push `sunSize`/`cloudTowering`,
  warm the tint toward flamingo-pink); drop sea state + author a glassy
  inner-bay `waveZone`; turn the **waterline trio** on (after #1).
- **P1** Light the **Versace Steps + seaplane wing-ramp** as the postcard moment;
  make the wing read as an obvious takeoff lip.
- **P2** Dress: neon-sign + string-light glow emitters, palm-sway motes, gulls,
  lounge chairs/flamingo on the pool deck, the pool-deck shortcut plinth read.
- **P2** Verify the rooftop-chain skim heights + pool-deck shortcut play as
  designed (13 checkpoints currently).

**Verdict:** the **biggest lift**, but mostly because of one un-diagnosed
render blocker sitting on top of a genuinely complete build. If the dark-render
turns out to be the `COLOR_0` re-export or an ambient tune, this track jumps
forward fast.

---

## Cape Town Drift — *Reef #2* (landmarks built, not yet reading)

**Design intent** ([cape-town-drift.md](tracks/cape-town-drift.md)): drowned V&A
Waterfront, **Table Mountain** dominating every horizon; 48 s × 3; the **calm-
water skill check** (Drake Lake analog) — glassy harbour slalom through half-sunk
containers + a tipped ferry, the **Two Oceans Wreck** (aquarium + circling great
white) set-piece, a Cape Wheel underpass, market finish.

**Art target** ([cape-town-drift-art-target.md](tracks/cape-town-drift-art-target.md),
Reef pastel **cool grade**, **25 built / 50 broken / 25 blooming** — the cup's
broken-heavy ruin-field): bright cool Atlantic blue, **oxidised container reds**,
the leaning **red Cape Wheel**, the flat-topped grey-green mountain on every
horizon. "Lock the Table-Mountain ring + Cape Wheel first."

**Current state (evidence):**
- **Geometry + identity + set-pieces: all built.** 2.7 MB GLB, 19 nodes:
  terrain + 1 peak, **`horizon_ring`** (Table Mountain), **`cape_wheel`**,
  **`aquarium_hall`** + **`great_white`** (the Two Oceans Wreck — visible as a
  glass dome with a shark silhouette inside, capture frame 14), a
  **`grounded_freighter`** (tipped ferry), **`wreck_containers`**, and
  `harbour_dressing`. The material palette is rich and correctly colored:
  `mat_cont_red/teal/rust`, `mat_cape_wheel` (red), `mat_bld_blue/roof/teal/
  cream/ochre`, `mat_shark`, `mat_freighter_hull`. Unlike South Beach, **Cape
  Town renders its colors** (red containers, the glass dome all read in-engine).
- **Grade/water/sky: cool grade landing.** `cape_town_blue` + a configured
  volumetric `clouds` block → bright Atlantic blue water + clean blue sky with
  puffy cumulus (frames 00–14). The best sky read of the two unfinished tracks.
- **…but the identity landmarks don't read.** Across six captured frames the
  **Table Mountain `horizon_ring` and red Cape Wheel are not prominent** — the
  mountain washes into the hazy horizon, the wheel isn't a hero silhouette. For
  a track whose mountain is "**30 % of its identity, lock early**," that's the
  central gap: the geometry exists but isn't **legible** (scale / position /
  color-vs-sky / placement relative to the racing sightlines).
- **Harbour detail is flat.** Containers/aquarium read as clean flat-color blocks
  — the **broken-50 % oxidation/rust/barnacle** note (the dominant material state
  here) isn't authored, because it's a `COLOR_0`/waterline job and `COLOR_0` is
  missing on all 25 non-terrain meshes + `waterline 0`.
- **`timeOfDay: 125`** — anomalous (siblings are 0–0.85). It doesn't *break*
  lighting (renders as a bright day), but it should be normalized; verify it
  isn't pinning the sun at an unintended angle.
- **Water not calm enough for the slalom.** Global Beaufort 2 with no Beaufort-1
  interior zone; the design's whole point is glassy slack water where pumping
  stops paying. `waveZones` empty.
- **Waterline `0`; runtime props/emitters `0`** (shark-tank foam, container-rust,
  gulls, market stalls, the ferry as a mover).

**Gap → tasks:**
- **P0** Make **Table Mountain + the Cape Wheel read** — scale/position/silhouette
  tune so they sell Cape Town in the first 3 s from the racing line (compare to
  `cape_town_hero_aerial`). This is the identity gate.
- **P0** Full-field completion check (cross-cut #3) — Cape Town has prior AI-jam
  history; re-verify after any gate/terrain nudge.
- **P1** Normalize `timeOfDay`; author a Beaufort-1 harbour-interior `waveZone`
  for the glass slalom; turn on the **waterline trio** (after cross-cut #1).
- **P1** Weather the ruin-field: oxidised-red rust + barnacle crust on containers
  + freighter (the broken-50 % note) via the `COLOR_0`/waterline pass;
  **light the aquarium tank interior** so the great-white silhouette is
  unmistakable (it currently reads as a small shape in a plain dome).
- **P2** Dress: `emitter_container_rust`, `emitter_shark_water` foam, gulls,
  market stalls + warm survivor windows at the finish; confirm the Cape Wheel
  **underpass** lower-arc is `kind=track` and the line under it is obvious.

**Verdict:** ahead of South Beach on grade + renders-its-colors; the work is
**legibility + weathering + dressing + wiring**, not building.

---

## Suggested sequence (most leverage first)

1. **Cross-cut #1 — fix the `COLOR_0` export** and re-export all three. One
   pipeline fix; unblocks the waterline trio + weathering everywhere and is the
   first lever to test on South Beach's dark render. *(½–1 day)*
2. **South Beach dark-render diagnosis** (cross-cut #1 result + ambient/sun
   tune). Until the hotels show pastel, nothing else on SB is judgeable. *(½–1 day)*
3. **Full-field (8-bike) completion** on all three (cross-cut #3) — cheap, and it
   gates "playable." Fix any gate-jam before investing in art. *(½ day + fixes)*
4. **Per-track grade/water/wiring**: SB sunset grade + calm bay zone; CT landmark
   legibility + calm slalom zone + `timeOfDay`; Sandbar marina brighten/reframe +
   crest dune. *(1–2 days each for SB/CT, ½ for Sandbar)*
5. **Waterline trio + weathering pass** on every shore/structure (now unblocked).
   *(1 day across all three)*
6. **Dressing + emitters** to JetMoto edge-density; **commit Sandbar's racing-line
   WIP**. *(1–2 days)*
7. **Slice playthrough**: menu → 3 races → standings → podium, on target-ish
   hardware, eyeballing the 8-bike perf (single-bike is 74–106 fps on the dev GPU
   today — 8-bike on Deck/3070/iPhone is the real, still-unmeasured target).

**Rough total:** order of **8–12 working days** to a genuinely art-complete,
full-field-playable 3-track + cup slice — front-loaded on the shared `COLOR_0`
fix and the South Beach render diagnosis, which de-risk the rest.

---

## Open questions to resolve early

- **South Beach dark render** — which of `COLOR_0` / ambient-lighting /
  material-binding is it? (Determines whether SB is ~2 days or ~6.)
- **`timeOfDay: 125`** on Cape Town — typo for `0.125`, a different unit, or
  harmless? Normalize and confirm sun angle.
- **Sandbar crest-launch dune** — is the wave-mastery lesson actually built
  (no `crest_berm` node in the GLB), and does it read?
- **Sandbar horizon silhouettes** — intended distant dunes, or stray mountains?
- **`wave_zone` empties in the GLBs vs empty `waveZones[]` in JSON** — is the
  per-beat zoning meant to come from the GLB empty (and isn't being consumed) or
  from JSON (and was never authored)? Pick one source of truth.

---

## Appendix — evidence

### Sky / grade / water knobs (from `public/tracks/<id>.json`)
| Knob | Sandbar | South Beach | Cape Town |
|---|---|---|---|
| `colorGrade` | `venice_warm` | `miami_pastel` | `cape_town_blue` |
| `cloudTowering` | **0.75** | 0.35 (default) | 0.10 (+`clouds` block) |
| `sunSize` | **1.7** | 1.1 | 1.0 |
| `bloom` | 0.35 | 0.35 | 0.16 |
| `timeOfDay` | 0 | 0.85 | **125 ⚠️** |
| `seaStateBeaufort` | 1 | **4** | 2 |
| `terrainShader.waterline` | **1** | **0** | **0** |
| `waveZones[]` | 0 | 0 | 0 |
| `props[]` | 25 (+100 buoys) | **0** | **0** |
| checkpoints | 7 | 13 | 14 |

### GLB geometry inventory (`public/assets/tracks/<id>.glb`)
| | Sandbar | South Beach | Cape Town | (the-maw ref) |
|---|---|---|---|---|
| size | 15.0 MB | 1.5 MB | 2.7 MB | 15.6 MB |
| nodes / meshes / mats | 50 / 28 / 12 | 313 / 252 / 21 | 19 / 8 / 23 | — |
| identity / set-pieces | marina (shack/dock/sign), ramp, sea-stacks, 12 palms | **full Art-Deco kit + Versace + seaplane ramp + lifeguard**, 36 palms, skyline | **Table Mtn ring + Cape Wheel + aquarium + great white + freighter + containers** | arches/shoals |
| prims w/ `COLOR_0` | 15 / 31 | **1 / 263** | **1 / 26** | 40 / 50 |
| only mesh w/ `COLOR_0` | (terrain + mains) | `terrain_mesh` only | `terrain_mesh` only | (most) |

### In-engine captures
`test-results/track-shots/{sandbar,south-beach-sunken,cape-town-drift}/00–15.jpg`
(real WebGPU, autopilot sweep, 2026-06-05). Concept plates:
`C:\project-content\hoverbike\concept-art\midjourney\<track>\best\`.

### Cross-references
- Design: [tracks/sandbar.md](tracks/sandbar.md) ·
  [tracks/south-beach-sunken.md](tracks/south-beach-sunken.md) ·
  [tracks/cape-town-drift.md](tracks/cape-town-drift.md)
- Art: [track-art-direction.md](track-art-direction.md) +
  [tracks/sandbar-art-target.md](tracks/sandbar-art-target.md) ·
  [tracks/south-beach-sunken-art-target.md](tracks/south-beach-sunken-art-target.md) ·
  [tracks/cape-town-drift-art-target.md](tracks/cape-town-drift-art-target.md)
- Process: [track-art-pass-playbook.md](track-art-pass-playbook.md) ·
  [v1-work-breakdown.md](v1-work-breakdown.md) · [status.md](status.md)
