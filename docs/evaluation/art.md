# King Tide — Art Evaluation

> Evaluated 2026-08-22 · full-project review · perspective: Art

## Scope & method

Read the full art-direction doc suite (`docs/art-direction.md`,
`docs/painterly-vinyl-pipeline.md`, `docs/painterly-legibility-plan.md`,
`docs/ui-art-direction.md`, the track/prop/bike per-domain docs, the three
reef-cup review/catalog docs, art-target docs for the dressed tracks) and
opened the render source it claims to describe (`src/engine/render/`:
painterly-vinyl-material, illustrative-lighting, waterline, water, sky,
post-pipeline, signal-colors/state, racing-line-ribbon, terrain-shader,
quality-preset), plus `index.html` tokens, `src/engine/branding.ts`,
`src/engine/menus/tracks-catalog.ts` + `menu-flow.ts`, the Blender addon
(`tools/blender/kingtide_addon/`, brush/trim/thumbnail tooling), the shipping
track JSONs under `public/tracks/`, and CREDITS.md / CONTENT-LICENSE.md /
NOTICE. No GPU on this machine, so nothing was run headed; every "verified"
below means verified in source/data, not by eye — per trap #1, absent
GLBs/textures in `public/assets` were treated as expected, not as findings.

## Executive summary

This is one of the most disciplined art directions I have reviewed on a project
of this size — solo-dev or otherwise. The painterly-vinyl thesis ("Sea of
Thieves surface on a TF2 silhouette", built/broken/blooming, glow-is-a-privilege,
the shader-driven waterline) is stated in one canonical doc with explicit
deference rules, and — unusually — the engine actually implements it: the TF2
diffuse warp ramp ships **on by default** via a real custom `LightingModel`,
the shared vinyl material carries triplanar scanned-oil brushwork, edge-wear
drybrush, and the world-space waterline trio, and the "Regatta" UI tokens in
`index.html` match the UI bible hex-for-hex. Content-state honesty is equally
strong: the `art: 'dressed' | 'greybox'` field badges greybox venues in-menu,
and the art-director review loop demonstrably closed its own P0s (the Mexico
City water/sky rescue values are sitting in the shipped track JSON). Licensing
and AI-content hygiene (Hunyuan retirement, in-game CC BY attribution for the
brush stamps) are exemplary. The weaknesses are concentrated, not diffuse: the
proof-of-thesis Reef Cup is still only 2-of-3 dressed with Cape Town's identity
failure unresolved; the contrast-budget grade — the legibility plan's keystone
"budget vehicle" — is wired but authored on **zero** tracks; the
style-as-legibility signal system is built but default-off and unplaytested;
the per-domain art docs still read v1; and the look has no automated
regression, resting entirely on one person's headed eyeball.

---

## 1. The direction docs — coherence and quality

**`docs/art-direction.md` is a genuinely excellent art bible.** It does the
four things most studio art bibles fail at:

- **A one-breath thesis** ("post-apocalyptic solarpunk, arcade-stylized… a
  spectator sport during the collapse — not ruin porn") with a falsifiable
  test: "if a screenshot reads as bleak, grey, or mournful, it is wrong"
  (art-direction.md:42-47).
- **An operational vocabulary, not adjectives.** The built/broken/blooming
  material-state rule (art-direction.md:151-184) turns mood into a per-scene
  ratio an artist can hit and a reviewer can audit; worked examples per venue
  give calibration. The waterline rule (art-direction.md:189-212) is specified
  as a *mechanism* (world-space-height shader bands), not a wish — and that
  spec is implemented verbatim in `src/engine/render/waterline.ts`.
- **Anti-references and "two ditches"** (low-poly faceted vs 2D watercolour,
  art-direction.md:100-146) — naming the failure modes is what keeps
  independent passes convergent, and the concept-art recipe even encodes them
  as Midjourney `--no` bans (art-direction.md:410-433).
- **Explicit canonicality and deference** — every doc in the suite states what
  it is canonical for and what it defers to. This is why a nine-doc art suite
  hasn't collapsed into contradiction.

The palette appendix pins four cup families to concrete hex with consistent
*roles* (sky/key, water, built, broken, blooming, emissive) so a builder can
sample by role (art-direction.md:335-406). The UI tokens later sample these
same values — the system is actually closed-loop.

**Two doc-level weaknesses:**

1. **The per-domain companions still read v1**, and art-direction.md admits it
   ("a ripple pass is pending", art-direction.md:27-28).
   `track-art-direction.md` carries a top warning and a historical 13-track
   table including cut content (South Beach row); `prop-art-direction.md` got
   a v1→v2 patch note; but **`bike-art-direction.md` has no v2 note at all**
   — its register line is still "clean stylized toy" with no painterly-vinyl
   mention in the header. A contributor generating bike concepts from that doc
   will produce the v1 register.
2. **`painterly-legibility-plan.md` holds three generations of truth in one
   file.** The 2026-06-14 status block says the warp ramp shipped ON, while
   Part 1's tables below it still say "Never wired into the vinyl material /
   lighting is stock PBR" (painterly-legibility-plan.md:183-189) and list the
   sway bug and dome-only grade as open — all superseded above. The
   2026-06-16 water note says `contourBreakup`/`langmuir`/`riseStroke` were
   *removed*, while Part 1 still lists them ON with strengths. The plan is
   right in aggregate but a reader must know which paragraph wins.
   (`rendering-tech-review.md`, by contrast, was properly reconciled — its
   outline item carries a strikethrough + "superseded" note at line 104.)

## 2. In-engine realisation — implemented vs planned

The headline finding: **the look is substantially real, not aspirational.**
Verified in source:

| Claimed | Verified where | State |
|---|---|---|
| Unified runtime vinyl material (rim, matte, weathering wash, brush strokes, waterline, per-object size stamps) | `src/engine/render/painterly-vinyl-material.ts` (1,004 lines) | **Built.** Includes the size-shared material design that collapsed Mexico City's shader compiles 155 → 73 via `userData()` reference nodes — a sophisticated, documented perf/look tradeoff (painterly-vinyl-material.ts:93-116). |
| TF2 diffuse warp ramp + additive rim | `src/engine/render/illustrative-lighting.ts` | **Built, warp ON by default.** A real `LightingModel` subclass overriding only `direct()`, with the "knob 0 == byte-identical" guarantee reasoned in the header (illustrative-lighting.ts:14-52). This is the correct mechanism, not a post-tint hack. |
| Shared world-space waterline trio | `src/engine/render/waterline.ts` | **Built**, algae-as-tint (not paint-over) with the seam-fix rationale in comments; shared by terrain and props, ON by default for props. |
| Real scanned-oil brush sheet, 3 scales in R/G/B, size-adaptive | `brush-strokes.ts`, `tools/blender/build_brush_texture.py`, `brush_stamps/README.md` | **Built**, with a procedural-bristle fallback so a fresh clone renders (a genuinely good pipeline decision). |
| Edge-wear drybrush from baked convexity | `edge-wear-convexity.ts` (`COLOR_0.A`) | **Built.** |
| Bloom + scene-wide grade | `post-pipeline.ts` (threshold 0.85; identity-default `setGrade`, always-present uniforms) | **Built** — but see the authoring gap below. |
| Signal-colour vocabulary + rim-as-signal + racing-line ribbon | `signal-colors.ts`, `signal-state.ts`, `racing-line-ribbon.ts` | **Built, default-off** (`?signals=1`, `?raceline=1`). |
| Stylized Gerstner water: oil-stroke foam, crest SSS, contour/value-ramp layers | `water.ts` (5,838 lines) | **Built**; foam-brush default 1.0, crest SSS default 0, contour/ramp at whisper defaults (0.16/0.6) per the 2026-06-16 "allover noise" correction. |

Three gaps between plan and reality matter to an art director:

1. **The contrast budget has a vehicle and no driver.** `sky.scenicGrade` is
   parsed (`json-loader.ts:1237`), seeded into the pipeline (sky.ts:437-469),
   and identity by default — and **no track JSON in `public/tracks/` sets
   it** (grep: zero hits). The legibility plan's entire thesis is "cap world
   spend, reallocate to gameplay events"; today no world is capped. Worse,
   the grade node lives inside the post chain that Low tier sheds, so the
   budget silently doesn't exist on Low (`quality-preset.ts:68-75`, flagged
   as intentional-for-now).
2. **Track B (style-as-legibility) has not reached players.** Every signal —
   drift-charge rim ladder, pickup pulse, rival draft rim, the racing-line
   flow ribbon — defaults off behind dev flags pending playtest sign-off. The
   plan's own "definition of done" (grayscale/squint pass; brightest thing on
   screen is a gameplay event) has not been run. Built-but-off is inventory,
   not product.
3. **Intake automation (P4/P5) is still open** — the readiness auto-router and
   the ≤512 texture-budget pass are the two "missing" rows in
   painterly-vinyl-pipeline.md's own status table (lines 190-191), which
   blocks cheap use of the staged 320-model building/nature packs the
   quality catalog wants for density.

## 3. UI/HUD art — "Regatta"

`docs/ui-art-direction.md` is the best single doc in the suite. The call
(painted race-day signage over neon holo-broadcast) is argued *from the art
bible's own rules* — neon chrome fails warm-vs-cold, fails painted-vs-drawn,
and spends emissive on dead surfaces — and lands on a memorable law: "the UI
is a prop from the world" (ui-art-direction.md:24-46).

Verified in code:

- **Tokens match the doc exactly**: `--bc-ink #fff5e1`, `--bc-navy #07222c`,
  `--bc-cyan #6cffc8` ("emissive mint — focus/live only"), Lilita One + Nunito
  loaded async from Google Fonts (index.html:9-60). The doc's cleverest move —
  keeping the `--bc-*` names (hundreds of usages) while re-reading "bc" as
  "base chrome" — avoided a rename churn with zero design cost.
- **The name lives in one place**: `src/engine/branding.ts` exports
  `GAME_TITLE`/`GAME_TAGLINE`, with the two un-importable `index.html` strings
  comment-flagged. The naming pitch table (King Tide ⭐ vs Tide Riders etc.)
  with logo consequences considered is exactly what a UI direction doc should
  contain.
- **Discipline extended to negative space**: the "deliberately not shown" HUD
  list (no speedometer — speed is read from the world; no persistent
  leaderboard) mirrors the design-targets anti-target practice.

The one soft spot: the doc's P1 items (painted track-card vignettes from the
MJ art, finish-line banner moment, rival ticker) and the review's "podium
stage is dark/empty — wants painted banners to match the Regatta signage"
remain visibly un-landed in recent history (git log since #25 is menus/CI/
boot, not chrome dressing). The menu got real attention (the 2026-08-21
low-tide Mayday Bay backdrop replacing the AI concept plate — an honesty
*and* art improvement, `src/boot/attract-backdrop.ts`), so the machinery is
warm; the P1 skin work is queued behind it.

## 4. Content-state honesty & the review loop

This project is unusually honest about what is finished, and the honesty is
*enforced in data*, not just prose:

- `tracks-catalog.ts:48` — `art: 'dressed' | 'greybox'`, documented as
  orthogonal to `status: 'ship'`, with the playtest rationale ("the biggest
  trust break was 'neon still on' opening onto beige dunes") in the comment.
  `menu-flow.ts:473-476` renders "Early route · art pass coming" on greybox
  tiles. Exactly 2 of 13 catalogue tracks claim `dressed` (`sandbar`,
  `mexico-city`); `cape-town-drift` correctly stays `greybox`;
  `VISIBLE_CUPS = ['reef']` keeps the unbuilt cups off the menu
  (tracks-catalog.ts:250). The Maw's absence from the card is deliberate
  B-list parking, matching docs.
- **The art-director review loop demonstrably works.**
  `reef-cup-art-director-review.md` (2026-06-16, headed real-GPU capture) is
  a credible AD review — specific, ranked, per-track triage — and its P0
  pass is *auditable in the repo*: the Mexico City rescue values it names
  (`tint #ffcdb0`, `sunSize 1.6`, `fogFar 1800`, `seaStateBeaufort 1.3`,
  `mexico_city_rosa` grade) are exactly what `public/tracks/mexico-city.json`
  ships today; the cyan wireframe boost-pad fix and the Cape Town fog/
  `silhouetteDark` changes are documented with root causes; the
  field-completion e2e it spawned found real 8-bike jams.
- The craft audit (`reef-cup-art-quality-catalog.md`) applies a judged-by-eye
  method rule ("datablock name ≠ geometry — verify by looking") and defines
  "AA-quality *for this game*" in the project's own register rather than
  borrowed photoreal standards.

**What has *not* been acted on** from that review, two months later: the P1
"sell the place" list — Mayday Bay's marina hero, El Ángel reading, Cape
Wheel repositioning (it sits at z=360, behind the start line, out of the
forward sightline), container weathering, podium dressing — and Cape Town's
AI-completion terrain rework. (One caution: the review's own "cp6
raised-sandbar" diagnosis is itself stale — the spec's 2026-06-22 comment
records cp6's gate jam *fixed* (reoriented to the cp5→cp7 chord), with the
field now stalling at **cp9, the Table Mountain summit**; the
field-completion spec `test.fixme`s cape-town-drift pending a terrain
re-grade that its 2-point-spline `.blend` stub can't yet export, and
README.md:188 still carries the AI-jam known issue.) The intervening work
(playtest funnel, menus, CI, licensing) was arguably the right priority, but
the cup's third track has been "identity missing" since June.

Prop-density reality check from the shipped JSONs: `cape-town-drift` 330
props (313 shipping containers), `mexico-city` 78 (a bespoke `mxc/` family —
33 ahuehuete, 32 jacaranda, 7 trajineras — the Texcoco pass produced
track-specific vegetation, which is the right instinct), `sandbar` 26 (all
`cc0/`). Mayday Bay's count is low because much of its dressing is GLB-baked,
but the bible's "30–80 moving objects" and mid-ground-band targets are still
unmet everywhere — "alive" emitters (gulls, papel picado, kelp sway) remain
P2 on the review's list.

## 5. The authoring pipeline as an artist lives it

Strong, and unusually well-hubbed for a solo project:

- **The export-ownership contract is the single best pipeline idea here.**
  `track-art-pass-playbook.md` §1 spells out `BLENDER_OWNED_JSON_KEYS` vs
  editor-canonical keys, so an artist knows `props[]` edits survive re-export
  and geometry edits require one. Prop placements mirror into a hidden
  Blender preview collection that auto-syncs on file open, with write-back
  ("Write Prop Placements → JSON") and per-instance float-on-waves. This is
  a real bidirectional artist workflow, not a one-way exporter.
- **The addon is substantial**: ~44 modules (terrain, road/ramp/tunnel,
  scatter + scatter-stroke, propline, wave zones, sky presets, decals,
  thumbnails, auto-tagging), installed once via symlink
  (`pnpm install:blender-addon`), with import/registration smoke tests
  (`test_addon_imports.py` etc.) and `pnpm test:blender` in the hard rules.
- **The look-tuning loop is layered correctly**: sheet *shapes* regenerate
  offline (`gen:brush-stamps` → `gen:brush-texture`, deterministic, ~3 s, no
  GPU, with a 1×1 fallback so clones never break); look *strength/scale* is
  live-tuned in-engine via `brush-tuning-service.ts` (no recompile);
  per-prop validation in `?propviewer=<id>` with rim/weather/brush sliders
  and raw/vinyl + waterline toggles (`src/viewer/prop-viewer.ts`), plus
  `?track=prop-showcase` for at-speed reads. The pipeline doc even records
  the hard-won lesson that texture-space previews lie ("the 2026-06-06 dots
  bug") — institutional memory a hired artist would benefit from.
- **Thumbnails/heroes are automated**: `render_track_thumbnail.py` delegates
  to the addon's single source of truth, auto-fires on track export, writes
  `<id>-hero.jpg`/`<id>-thumb.jpg`, exits non-zero on a missing
  `camera_hero` — and `menu-flow.ts:456` consumes exactly that path.
  `gen:ui-shots` / `gen:track-shots` give repeatable contact sheets.
- **The concept-art recipe is reproducible**: the `--sref` style-lock +
  prompt shape + both-ditch `--no` bans, with canonical frames named in the
  external store, and both dressed tracks have art-target docs recording
  their curated MJ beats and prompt lanes.

Two pipeline risks an artist would hit:

1. **The external stores are Windows-pathed and effectively single-machine.**
   Docs hardcode `C:\project-content\hoverbike\…` (override:
   `$KINGTIDE_CONTENT_ROOT`) for `.blend` sources, concept art, and the
   Quaternius packs; the canonical `--sref` frames live only in that
   Drive-synced root. Credit where due: `docs/disaster-recovery.md` is a
   real runbook for both SPOFs (R2 mirror recipe, weekly offsite
   `rclone copy` of the content root) — but by its own admission both stores
   have "no second copy by default", its prevent-checklist boxes sit
   unchecked, and there is still no documented way for a second artist (or
   the same artist on the Deck/Linux box the game targets) to get access to
   the content root. The bus-factor is documented, not yet retired.
2. **Look verification is 100% human-gated with no baseline.** All visual
   gates need a headed GPU (hard rule 2; CI's e2e/QA jobs skip by design and
   would fail on GPU-less runners anyway). `gen:track-shots` produces frames
   but nothing diffs them — a shader/driver/three-bump regression in the warp
   ramp or waterline would be caught only if Matt happens to look. The
   playtest-is-truth culture is right for *tuning*, wrong as the only
   *regression* net.

## 6. AI content, credits, licensing

Exemplary — this is how AI-era content hygiene should look:

- **CREDITS.md** itemises all 14 FMA soundtrack tracks with per-track
  licenses and the practical constraints spelled out (SA tracks poison
  trailer videos; the one NC-SA track compounds it) — CREDITS.md:41-46.
- **The Hunyuan retirement is a model decision**: the AI prop lane was killed
  in 2026-08 because Hunyuan3D-2's licence forbids distribution into the
  EU/UK/South Korea — "incompatible with a worldwide-playable game"
  (CREDITS.md:80-85). Verified: zero `"ai/` references remain in any
  `public/tracks/*.json`. The prompts/seeds are kept as a human-authored
  record. Someone here actually read a model licence's territory clause and
  acted on it; most shipped indies have not.
- **CC BY obligations are discharged in-product**, not just in the repo: the
  Blender Studio Brushstroke Tools attribution the brush-stamps README
  requires is rendered on the in-game credits screen
  (`menu-flow.ts:1584-1592`).
- **CONTENT-LICENSE.md / NOTICE** cleanly split MIT code from CC BY-NC 4.0
  first-party content, carve out third-party and AI material, and reserve
  the name/branding — with the honest position that raw AI output carries no
  copyright claim.

One watch item: the game itself is currently non-commercial-safe with its NC
music, but the content plan should flag which soundtrack rows must be
replaced before any commercial (Steam) release — the constraint is recorded,
the swap plan is not.

## 7. Art-debt risks (summary)

1. **Single-bar quality reference.** Mayday Bay's water is "the bar" by the
   review's own words; with only two dressed tracks, every register question
   ("how painted is painted?") still resolves by precedent-of-one-or-two
   rather than by the docs alone. The bar doc suite mitigates but the third
   dressed track will be the real test of convergence.
2. **Rider/bike asset defects undermine the explorer read**: four `Ride_*`
   clips are byte-copies of the chair-sit idle and stunt's `socket_seat` is
   ~0.95 m too high (status.md, 2026-08-19). Code-guards mask it; the
   `.blend` re-author is the fix and it is character work — the most
   identity-dense pixels in the game.
3. **Hero set-pieces still under-read on the dressed tracks** (marina,
   El Ángel) — the postcards are the weakest assets relative to importance,
   per the project's own audit, and nothing in git since June contradicts it.
4. **Doc drift debt** (legibility plan's internal contradictions,
   `level-visual-quality-research.md` still claiming bloom is schema-only and
   sway is never invoked) will cost a future session a re-derivation.
5. **Dev-only visibility of the signal layer** means the art direction's most
   original idea — style as the HUD — has zero player-hours of validation.

---

## Top 10 fixes & improvements (ranked)

1. **Finish Cape Town Drift — identity landmarks onto the sightline, the
   summit terrain re-graded, art pass to `dressed`.** The Reef Cup is the
   declared proof-of-thesis and its closer still reads "generic bright
   ocean": Table Mountain now silhouettes but stays off-palette blue-grey
   (the grey-green re-export is an open P1), the Cape Wheel sits behind the
   start line (z=360 vs racing-line max z≈300), and the AI field still
   stalls on the cp9 Table Mountain summit — cp6's gate jam was fixed
   2026-06-22, but the field-completion spec `fixme`s Cape Town pending a
   terrain re-grade its 2-point-spline `.blend` stub can't yet export. Until
   this lands, the player's first cup ends on the track that breaks the
   fantasy — and the "2 of 3 dressed" asterisk follows every trailer and
   store shot.

2. **Author the contrast budget: set `sky.scenicGrade` on all three Reef
   tracks and run the grayscale/squint definition-of-done.** The A2 grade —
   the legibility plan's declared keystone vehicle — is wired, validated, and
   used by zero tracks; the muted world band that funds every gameplay signal
   doesn't exist yet. Players currently parse boost/hazard/pickup against a
   world that spends contrast indiscriminately; a two-line JSON edit per
   track plus an eyeball pass converts the whole legibility thesis from
   built to real.

3. **Ship (or consciously cut) the signal layer: rim-as-signal + racing-line
   ribbon out of `?signals=1` purgatory.** The rival draft rim, pickup pulse,
   charge ladder, and flow ribbon are implemented, headed-verified, and
   invisible to every player. Style-as-HUD is the art direction's most
   differentiated idea; a playtest pass to tune hues/widths and flip
   defaults would give players at-speed reads (who's drafting whom, where
   the line is) that the HUD alone can't — or a decision to cut would stop
   the inventory rotting.

4. **Land the P1 "sell the place" items on the two dressed tracks: marina
   hero, El Ángel, podium dressing.** The project's own art-director review
   found the hero set-pieces are the weakest assets relative to importance,
   and two months of subsequent work went elsewhere. These are the postcard
   frames — the screenshot a player shares, the venue card, the finish
   moment — and the podium is currently a dark stage under a painted-signage
   UI that promises a festival.

5. **Fix the rider/bike character assets (`Ride_*` clips, stunt
   `socket_seat`).** Four riding animations are byte-copies of a chair-sit
   idle and one bike seats the rider a metre high; runtime guards hide the
   worst of it. The rider is where "salvage-built, personalised" explorer
   fantasy lives per the bike direction doc — every race, every replay, every
   podium shows this defect at the centre of the frame.

6. **Ripple-pass the per-domain art docs to v2 — bike doc first.**
   `bike-art-direction.md` still opens on the superseded "clean stylized toy"
   register with no v2 note; track/prop docs carry warnings but stale bodies.
   Every future concept pass (human or MJ) seeded from these docs pulls
   toward the wrong register, and the divergence lands in front of players as
   inconsistent bikes/props that no runtime vinyl material can fully
   reconcile.

7. **Stand up a look-regression baseline on a GPU machine.** `gen:track-shots`
   and `gen:ui-shots` already produce repeatable contact sheets; nothing
   compares them. Commit a blessed baseline per Reef track + UI screen and a
   diff script (even a perceptual-hash threshold) run before pushes on the
   dev box or a future self-hosted runner. Today a three/driver/shader
   regression in the warp ramp or waterline ships silently unless one human
   happens to look — the entire look has no safety net.

8. **Close the intake gaps (P4/P5): readiness auto-router + ≤512
   texture-budget pass + the hand-painted hero-map lane.** The first two are
   the "missing" rows in the pipeline's own status table (the hero lane is
   its declared P5 gap), and they gate the ~320 staged Quaternius
   building/nature models the density plan depends on.
   Cheap conditioned buildings and blooming foliage are the fastest route to
   the "JetMoto density" mid-ground the checklists demand on every track a
   player flies through.

9. **De-single-machine the content stores.** `.blend` sources, canonical
   `--sref` frames, and the Quaternius staging all resolve to
   `C:\project-content\…` on one Windows box — one Drive account, "no second
   copy by default" by `docs/disaster-recovery.md`'s own admission. The
   runbook already prescribes the fix (weekly offsite `rclone copy` of the
   content root, a nightly R2 mirror); its checklist sits unchecked, and
   collaborator access to the content root is undocumented. Execute the
   checklist and write the second-machine/second-artist checkout story so
   the art pipeline survives a disk failure or a second pair of hands.
   Players feel this only when it goes wrong — as a content pipeline frozen
   at two dressed tracks.

10. **Reconcile the stale inventory docs** — mark `painterly-legibility-plan.md`
    Part 1 as the historical pre-work inventory (or strike superseded rows the
    way `rendering-tech-review.md` does), and banner
    `level-visual-quality-research.md`'s outdated pipeline table (bloom and
    sway have long shipped). These docs steer art sessions; every
    contradiction taxes the next pass with re-verification, and time spent
    re-litigating solved problems is time not spent on the tracks players
    ride.
