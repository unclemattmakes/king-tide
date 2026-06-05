> ⚠️ **READ FIRST — v2 status boundary (2026-06-04).** This file is a running
> changelog; everything below this banner is **v1-historical**. Since v1 we
> restarted content for **v2**, and three things below no longer reflect reality:
>
> 1. **Anti-grav is cut** (parked for a possible future DLC). No shipped track
>    places anti-grav zones — every `antiGravZones` is empty. Entries that brag
>    about shipping anti-grav segments (Liberty / Angkor / Kilauea) are
>    v1-historical and were already untrue against the reset v2 track data.
> 2. **Content is mostly greybox for v2.** Only **Sandbar, The Maw, South Beach
>    Sunken** are art-dressed; the other tracks were intentionally reset to
>    greybox route-stubs (PR #285) for the v2 art pass. "v1 lineup complete" is a
>    v1 statement, not a v2 one.
> 3. **The soundtrack is CC0 placeholder music, not commissioned/licensed.** The
>    14 `.opus` tracks play, but licensing is still open work. Entries calling
>    them "commissioned" / "licensed" are aspirational.
>
> Wave mastery has also pivoted to a motocross pitch-the-takeoff/landing model
> (the Mario-Kart fork), away from the press-forward-on-crest pump described
> below. See [CLAUDE.md](../CLAUDE.md) and [product-plan.md](./product-plan.md).

> **Last updated: 2026-06-05** — **Open Sea Cup → Harbor Cup (no-open-water
> pass).** After a Reef-Cup playthrough flagged open-water maps as off-pillar,
> the open-water **Open Sea Cup** was retired: every map must now combine
> over-water land/props with water. The replacement **Harbor Cup** (drowned
> harbor cities) runs **Needle Sound (Seattle) → Golden Gate Drowned (San
> Francisco) → Opera Drowned (Sydney)**:
>
> - **Golden Gate Drowned** moved up from Continental; **Shibuya Submerged**
>   (a land+water city track) backfilled the Continental slot it vacated.
> - **The Maw** + **Hatteras Light** (pure open water) parked to the
>   [B-list](./track-themes.md#b-list--future-content-packs) — files/GLBs kept,
>   pulled from the ship cups (still under QA so a GLB regression stays loud).
> - **Needle Sound** + **Opera Drowned** are fresh concepts (design docs in
>   [tracks/](./tracks/README.md)); they ship as **gated `pending` tiles** and
>   the **Harbor Cup tile stays `pending`** until their geometry is built (a
>   championship can't run through two unbuilt tracks). Golden Gate stays
>   individually playable from the race-mode track grid.
>
> Catalog: [tracks-catalog.ts](../src/engine/menus/tracks-catalog.ts) +
> [theme-catalog.ts](../src/game/tracks/theme-catalog.ts); pinned by
> [tracks-catalog.test.ts](../tests/unit/tracks-catalog.test.ts). Supersedes
> the Open Sea line in the entry below.

> **Last updated: 2026-06-05** — **Cups reworked + full-field results, trophy
> podium.** Three pieces, MK8 / Jet Moto-inspired:
>
> 1. **Reef Cup re-cut** to **Sandbar → South Beach Sunken → Cape Town Drift**;
>    **Hatteras Light** moves to the **Open Sea Cup** (now a 3-track cup with
>    The Maw + Shibuya). Lineups still derive from each track's `cup` field in
>    [tracks-catalog.ts](../src/engine/menus/tracks-catalog.ts) (+ the mirror in
>    [theme-catalog.ts](../src/game/tracks/theme-catalog.ts)); pinned by
>    [tracks-catalog.test.ts](../tests/unit/tracks-catalog.test.ts).
> 2. **Full-field championship.** A cup now seeds a **stable rival roster** at
>    start (`buildCupRoster`) so the same opponents — names, bikes, liveries —
>    ride every race; the broadcast intro + replay read it too. Each race
>    records the **whole field's** finish (not just the player), and
>    `cupStandings()` accumulates the MK8 points curve across the lineup so the
>    champion is the real top-of-table rider (which may be an AI). All in
>    [cup-progress.ts](../src/engine/cup-progress.ts), pinned by
>    [cup-progress.test.ts](../tests/unit/cup-progress.test.ts).
> 3. **Post-race results board** on the finish screen — every racer ranked, the
>    player highlighted, with points (cup) or finish time (single race) —
>    plus an **end-of-cup 3D podium ceremony** (`?podium=1`,
>    [podium-mode.ts](../src/boot/podium-mode.ts)): top-three bikes on a podium,
>    spinning trophy, confetti, scripted camera, then the championship standings
>    card with the player's trophy (gold/silver/bronze by overall rank, via
>    `trophyForRank`). The cup-finale finish screen's **PODIUM →** button hands
>    off here; the old player-only cup-results overlay is now the standings card
>    rendered over the ceremony ([cup-results-screen.ts](../src/engine/render/cup-results-screen.ts)).

> **Last updated: 2026-06-04** — **Slope-aware tuck sweet spot.** The tuck
> sweet spot is no longer pinned at 0.8 lean. On a descent it slides toward
> the feathered end (`slopeAwareSweetSpot` in
> [tuck-curve.ts](../src/game/systems/tuck-curve.ts)) so the rewarded lean
> matches the pitch the slope actually leaves room for. The bug it fixes: on
> a downslope the chassis is already pitched nose-down (the grounded pitch PD
> tracks the surface tangent) and the dive clamp eats the rest of the
> player's nose-down travel, so a fixed notch graded the reward off input the
> bike can't execute — the meter would march into `SCRAPING` while nothing
> scraped. The notch now reads the same speed-anticipated, low-pass
> `surfaceForwardSlope` the pitch PD + slope-momentum trust (so it pre-shifts
> for the wave face / ramp the bow probe sees), sliding to a 0.4 floor by
> ~28° of descent; flat ground and climbs are unchanged. **Single source of
> truth:** physics ([hover.ts](../src/game/systems/hover.ts)), the tuck-meter
> notch ([tuck-hud.ts](../src/engine/render/tuck-hud.ts) — `--tk-sweet` now
> re-set each frame), and the slipstream VFX
> ([fx/index.ts](../src/engine/render/fx/index.ts)) all grade off the same
> `slopeAwareSweetSpot`. A first step toward the v2 wave-mastery legibility
> goal (graded "master the jump" pitch). Pinned by
> [tuck-sweet-spot.test.ts](../tests/unit/tuck-sweet-spot.test.ts); the
> making-of [feel demo](../src/making-of/feel/tuck-demo.ts) gains a slope
> slider so the notch-slide is visible against the shipped curve. The **F4
> hover-debug overlay** (`?debug=hover`,
> [hover-debug.ts](../src/engine/render/hover-debug.ts)) also draws it
> in-world: a surface-forward-slope tangent line (stern↔bow surface hits —
> the signal that slides the notch, coloured by sign) plus a floating gauge
> per grounded bike — lean fill recoloured by tuck state, the live
> slope-shifted sweet-spot notch, and a faint flat-ground base-sweet tick so
> the shift reads at a glance.

> **Last updated: 2026-06-04** — **Breaking-crest wave spray** — the ocean now
> throws spray off its own crests, independent of the rider, so the water stops
> reading as a shaded rubber sheet. Three additive pieces, all gated by the new
> Settings → Video → "Wave spray" knob (full / subtle / off): (1) an ambient
> **crest-poof** driver ([wave-crest-spray.ts](../src/engine/render/wave-crest-spray.ts),
> pure + unit-tested like surge-spray) that sweeps a world-anchored lattice
> around the camera and fires a one-off `crestSpray` burst the moment a crest
> breaks over a cell — rising-edge/re-arm hysteresis on the same `height·slope`
> whitecap signal the GPU shades, so the poofs land where the foam already is;
> (2) **wave-aware bow spray** off a bike's nose when it drives into a rising
> wave face (climb-into-face "closing rate"), so pumping a crest is visibly
> rewarded; (3) a cheap **crest-mist ribbon** GPU emissive haze on distant steep
> crests, grazing- + distance-weighted to fill the far field where sprites read
> sparse. Render-only (never feeds the sim). Deep dive + tuning table in
> [docs/water-deep-dive.md](./water-deep-dive.md#breaking-crest-spray-particle-layer).
>
> **Last updated: 2026-06-03** — CC0 prop lane now renders **multi-tone**
> (`keep_material`) + a scaled-up prop set.
>
> **A third prop-sourcing lane: free CC0 packs (multi-tone).** Eleven CC0
> **Quaternius** packs are staged at `<content-root>/external/quaternius/`
> (extracted + catalogued in `MANIFEST.md` + `manifest.json`; the FBX-only packs
> converted to GLB via [`tools/blender/fbx_to_glb_batch.py`](../tools/blender/fbx_to_glb_batch.py)).
> They skip concept+Hunyuan and enter at the **conditioner** with its new
> **`keep_material`** mode: instead of stripping each pack's material for a flat
> `mat_prop` tint, the conditioner now **preserves** it — `baseColorTexture` +
> UVs, or flat multi-material slots — and stamps the contract around it
> (`COLOR_0` stamped *neutral* so it can't tint the texture; degenerate
> FBX `Alpha = 0` repaired to opaque), so CC0 props render **multi-tone with no
> engine/shader change**. Shipped: a **scaled-up set (~56 props)** across
> pirate / toon-shooter / crops / ships / cute-fish / cyberpunk →
> `public/assets/props/cc0/*.glb` (Git LFS; provenance + `keep_material` in
> `specs/props/cc0/quaternius.json`), a representative subset placed in
> [prop-showcase.json](../public/tracks/prop-showcase.json) `props[]` and
> verified headed/WebGPU (`pnpm gen:track-shots prop-showcase`). Deferred:
> **rigged** packs (`animated-fish` → conditions to a blob) and **high-PBR**
> packs (`downtown-city`, `stylized-nature` → multi-MB GLBs) need skinned-mesh /
> texture-budget passes first. (Sketchfab was a dead end: museum photogrammetry,
> not toy props.) Operational steps in [ai-prop-pipeline.md](./ai-prop-pipeline.md).
>
> **Last updated: 2026-06-01** — Midjourney → mesh: external concept art is now
> a working front-end for the AI prop pipeline, and multiview (Hunyuan3D-2mv) is
> unlocked on the 8 GB box.
>
> **The AI prop factory gained a second concept source.** A Midjourney v7
> concept (cleaned to one isolated solid object) can skip the ComfyUI/SDXL stage
> and feed **Hunyuan3D-2mini single-view** directly, then through the same
> `condition_ai_batch` → `public/assets/props/ai/`. First two MJ-pipeline props
> shipped: **`drift_buoy`** + **`cargo_crates`** (Sandbar) — conditioned
> (~2–2.5 k tris, `COLOR_0`, box collider, `mat_prop_*`) and placed in
> `?track=prop-showcase`; manifest provenance carries `"source": "midjourney"`.
> MJ-prompt lesson learned: the doc register name *"clean stylized toy"* makes
> Midjourney render literal vinyl figurines — prompt **"retro-future / weathered
> salvaged / painterly"** instead (the loved Scout look); and a hover-craft only
> reads wheelless when you describe *"hovers on a cushion of repulsion, clear gap
> beneath the hull"* (never a surface verb).
>
> **Multiview (Hunyuan3D-2mv) now runs locally.** The repo's mv-turbo pipeline
> (`{front,left,back}`, 5-step FlashVDM) was crashing at load with an access
> violation building DINOv2-giant — root cause was **RAM**, not deps: the
> conditioner builds the ~1.1 B-param encoder as fp32 random init on top of the
> already-loaded fp16 ckpt, peaking past free RAM. Fix: construct in fp16
> (`torch.set_default_dtype(torch.float16)`) in an isolated `hunyuan-mv` env.
> Single-vs-mv comparison: fronts identical, mv's back/sides are truer to the
> real view inputs — a modest gain on symmetric props. **Verdict: single-view
> stays the default** for 40 m/s stylized props; mv is reserved for a hero asset
> and still needs a consistent-view source (Zero123++) for our own concepts.
> Operational detail: [ai-prop-pipeline.md](./ai-prop-pipeline.md).
>
> **Last updated: 2026-05-31** — Sandbar art pass: first track dressed with
> the conditioned AI props. 30 placed props (`props[]` in
> [public/tracks/sandbar.json](../public/tracks/sandbar.json) — sea-stacks,
> boulders, wrecks, drowned cabs, anchors, rubble) seated on the real terrain
> + 12 instanced cove-edge palms baked into the env GLB. All props verified
> **outside the AI racing corridor** (Catmull-Rom AI line + buoy-wall
> clearance) so the loop stays completable; rocks sunk ~30% to read as
> rooted. The reusable method + gotchas are written up in
> [track-art-pass-playbook.md](./track-art-pass-playbook.md).
>
> **Last updated: 2026-05-30** — `make-level-props`: the local AI prop
> factory, now a level-scale orchestrator + validated end-to-end.
>
> **AI prop pipeline is built and proven.**
> [`make-level-props <level>`](../tools/make_level_props.py) (also the
> `/make-props` skill) runs the whole local, free concept→3D→prop chain over
> a track's prop list: resolve + auto-route (compact/solid → AI lane;
> thin/spanning → flagged procedural), then phase-batch the 8 GB GPU —
> ComfyUI concepts → contact-sheet **review gate** → Hunyuan image→3D →
> `condition_ai_mesh` → **review gate** → integrate as an `hv_locked` library
> asset. Two Blender helpers back it: `condition_ai_batch.py` (Phase C) and
> `integrate_ai_props.py` (lock-in). Validated end-to-end on **The Maw's
> `sea_boulder`** (clean SDXL concept → Hunyuan mesh → ~2 000-tri conditioned
> prop with a single `COLOR_0` + box collider → `hv_locked`, asset-marked
> `.blend`). Routing checked across all 13 tracks (≈11 AI props, the rest
> flagged procedural); the 12 remaining levels are routed and await a GPU
> run. Raw vs. compiled split (per [asset-storage.md](./asset-storage.md)):
> concept PNGs + per-prop `.blend`s live in the Drive content root; the
> committed anchors are the GLB (`public/assets/props/ai/`, Git LFS) + the
> per-level manifest (`specs/props/ai/<level>.json`). Operational guide:
> [ai-prop-pipeline.md](./ai-prop-pipeline.md); strategy:
> [props-production-plan.md](./props-production-plan.md).
>
> **Last updated: 2026-05-30** — Licensed soundtrack radio + credit toast,
> shoreline transition (shore-aligned waves, swash, wet sand), drift, tricks,
> hover polish, Electron Steam port, making-of microsite.
>
> **Licensed soundtrack drop — the shuffle radio the audio engine was built
> to receive.** 14 commissioned tracks transcoded MP3 → Opus by
> [tools/convert-music.mjs](../tools/convert-music.mjs) (`pnpm gen:music`;
> 70.7 MB → 32.7 MB), streamed via an `<audio>` element into the music bus
> rather than fully decoded into PCM. The jukebox
> ([soundtrack.ts](../src/engine/audio/soundtrack.ts)) shuffles across menus
> + races, ducks under the wave-pump / explosion sidechain for free (it's on
> the music bus), and supersedes the procedural pad bed — which stays as the
> no-assets fallback. An MTV / EA-Trax credit toast
> ([music-credit-toast.ts](../src/engine/render/music-credit-toast.ts)) slides
> in when each song starts, crediting `<artist> — <title>` parsed from the
> source filenames. Settings → Audio gains a "Now-playing credits" toggle and
> "Music bed enabled" became "Music enabled". Raw `.mp3`s live off-git in the
> content folder; compiled `.opus` is tracked via Git LFS. Regenerate after
> adding tracks with `pnpm gen:music`.
>
> **Shoreline transition — waves now break on the beach instead of dying.**
> The terrain heightmap used to just damp the swell to zero in the last ~3 m
> of depth (clean geometry, but a dead surf zone). It now *transforms* the
> swell into rideable, coast-parallel breakers. A deterministic, Three-free
> shore-field bake
> ([src/engine/sim/water/shore-field.ts](../src/engine/sim/water/shore-field.ts):
> distance-to-shore via a 2-pass chamfer transform + offshore normal + depth,
> baked in the same pass as the heightmap) is the single source of truth: the
> GPU samples it as an RGBA16F texture, the CPU buoyancy sampler reads the same
> arrays, so the bike rides exactly what's rendered. The shore wave's crests run
> parallel to the coast and march shoreward (`phase = K·dist + Ω·t`), amplitude
> peaks in the surf band and is capped by the water column so a trough never
> breaches the seabed. Foam re-syncs to the shore crests; a **swash run-up**
> pushes the lacy foam edge up the sand on each incoming crest and pulls it back
> in the trough; the terrain's **wet-sand** band + underwater tint were
> re-anchored from world y=0 to the real `track.water.height`, so the damp band
> sits at the actual shoreline on raised/sunken-water tracks. All mirrored
> CPU↔GPU via shared `SHORE_*` constants (drift-tested) and gated behind the
> `shoreWaveStrength` water-debug knob (0 = byte-identical legacy). Deep dive +
> tuning knobs + the deferred stateful drying-trail recipe in
> [docs/water-deep-dive.md](./water-deep-dive.md).
>
> **Drift — Mario-Kart-style mini-turbo lands.** Hold Z (left) or C
> (right) while steering into the corner; release fires a tiered boost
> (blue MT → orange SMT → purple UMT). Tier thresholds 0.6 / 1.4 / 2.4 s
> and boost multipliers 1.45× / 1.75× / 1.95× live in
> [src/game/systems/drift-tiers.ts](../src/game/systems/drift-tiers.ts);
> the drift system itself in [drift.ts](../src/game/systems/drift.ts)
> overloads the existing trick buttons (small hop on a flat-ground press
> *is* the drift initiator's tell, MK convention). HUD tier badge
> ([drift-tier-hud.ts](../src/engine/render/drift-tier-hud.ts)),
> color-shifted sparks at the outside-rear corner, skid-loop +
> tier-bell release whoosh (`audio.driftSkid` / `driftBoost`), rider
> banks into the slide, camera rolls 5/7/9° by tier. Inside-drift
> archetype (Sparrow, Stunt — `driftStyle: 'inward'`) gets a 250 ms
> initial-cut spike then a wider tail; outside-drift (Cruiser, Racer,
> Scout) hugs the apex with a stable flat bias. AI hits SMT on Standard
> and UMT on Hard from `decideAIDrift`; the tutorial picks up a DRIFT
> beat between WAVE PUMP and ANTI-GRAV. Settings → Gameplay → "Drift
> assist" (Full / Subtle / Off) gates sparks + audio + HUD badge +
> camera roll. **Drift Practice Range** dev track (`?track=drift-test`,
> surfaced in the Dev Cup picker) exercises every charge tier + grip
> surface on one loop. Full deep dive in
> [docs/drift-deep-dive.md](./drift-deep-dive.md).
>
> **Surface-type registry — per-collider lateral grip.** New
> [src/engine/sim/surface-types.ts](../src/engine/sim/surface-types.ts)
> tags each static collider with a `SurfaceType` (default / asphalt /
> metal 1.25× / sand 0.70× / ice 0.35× / water). The lateral-grip
> multiplier applies to BOTH normal driving and drift, so an ice patch
> feels coherent whether or not you're sliding. `default` keeps every
> untagged collider byte-identical to pre-registry behaviour — only
> explicitly-tagged patches change feel. Authoring: JSON `Prop.surface`
> for prop colliders, GLB `surface` userData extra for track meshes.
> The Drift Practice Range demonstrates it (ICE on the west SMT sweep,
> SAND on the south ramp straight). Blender authoring UI is the
> remaining follow-up — runtime + sync test already in place.
>
> **Tricks — geometric pop-based window.** Replaces the old
> vertical-velocity gate.
> [src/game/systems/trick-hop.ts](../src/game/systems/trick-hop.ts) now
> opens the window the moment the bike leaves its planted stance — nose
> lifting off a lip / ramp crest while the base is still down, a clean
> takeoff, or riding up/down a meaningful slope at speed (ramp,
> sandbar, ledge, embankment — both directions). The per-end contact
> flags (`HoverState.noseGrounded` / `baseGrounded`, chatter-debounced
> by the bow/stern hover probes) make the pop a first-class signal so
> lips, humps, and crests register long before the center probe would.
> Speed ≥ `MIN_SPEED_FRAC` × top-speed and throttle ≥ `MIN_THROTTLE`
> gates still reject coasting tricks. Pre-press buffer (200 ms) holds a
> trick press mid-climb so a button mashed *before* the bike's nose
> pops still fires when the window opens.
>
> **Tuck — snowboarder's nose-down sweet spot, no dedicated button.**
> Folded into the existing nose-down lean (Q / push stick forward, same
> `intent.pitch < 0` the dive-aid reads). Curve in
> [src/game/systems/tuck-curve.ts](../src/game/systems/tuck-curve.ts):
> ramps 0→1 to `TUCK_SWEET_SPOT = 0.8`, then winds back through zero to
> `TUCK_SCRAPE_FLOOR = -0.5` at full deflection where the dive-aid's
> ride-height drop already has the belly skimming. Signed factor
> interpolates `tuckSpeedBoost` (cap ×1.15) and `tuckDragMul` (drag
> ×0.5) off 1.0 — a feathered lean down a slope/wave face is fastest,
> burying the nose over-tucks (cap below base + drag above base + belly
> scrape). Grounded / over-water only. New `tuckStream` cyan slipstream
> VFX pool scales with sweet-spot proximity; new
> [`#hud-tuck`](../src/engine/render/tuck-hud.ts) accuracy meter shows
> bar fill + sweet-spot notch + status word (`LEAN IN` / `SWEET!` /
> `EASE OFF` / `SCRAPING`) + live cap-bonus %. Both gated by Settings →
> Gameplay → "Tuck slipstream VFX" + "Tuck meter".
>
> **Hover polish — dive kick, release kick, yaw-coupling fix, climb
> assist.** The pitch-down lean is now rate-limited and follows a
> dive-then-level curve so it stops flipping the bike on water; on
> release a `dive-kick` recovers the nose with a brief boost on the
> bow spring. Stern spring's boost-on-rise mirrors the bow curve so
> launches feel symmetric. The bow spring's stiffness curve is soft at
> the top and stiff past 1.0 at the bottom (so a clean wave rebound
> springs back but heavy landings absorb). Air branch reverts to pure
> free physics — no PD in air. The latest **yaw-coupling fix**
> (commit 20a5547) eliminates a sneaky term that pulled the nose along
> lateral slopes, so cornering across a bank no longer drags the bike
> sideways. Climb-assist is now gated on forward throttle so coasting
> bikes don't ride uphill.
>
> **Electron desktop port — replaces Tauri.** The Steam Deck / desktop
> wrapper is now Electron (`electron/main.cjs`) and ships its own
> Chromium so the game gets real WebGPU inside the Steam Linux Runtime
> container instead of the WebKitGTK WebGL2 fallback the Tauri shell
> was stuck on. Build path: `pnpm build:deck` (Linux tree),
> `pnpm build:windows` (NSIS installer + tree),
> `pnpm electron:run` (quick local). Steam-Deck-specific runtime
> patches: launch wrapper [`electron/hoverbike-launch.sh`](../electron/hoverbike-launch.sh)
> survives the Steam Linux Runtime, `--no-zygote` clears the sniper
> namespace crash, `--enable-unsafe-webgpu` + `--use-angle=vulkan`
> routing gated to Linux only (Windows-on-Proton black-screens with
> the ANGLE/Vulkan flag, Linux Wayland needs the Vulkan-through-ANGLE
> path). Linux Steam depot dropped — Windows depot only, Proton plays
> the Windows build on Deck (simpler than maintaining two depots).
> [docs/desktop-builds.md](./desktop-builds.md) +
> [docs/steam-deck.md](./steam-deck.md) document the full path.
>
> **Making-of microsite.** Six illustrated chapters with playable
> Three.js demos that import the *real* sim modules so they can't drift
> from shipped code:
> [making-of/wave-field/](../making-of/wave-field/),
> [buoyancy/](../making-of/buoyancy/),
> [feel/](../making-of/feel/) (tuck curve),
> [drift/](../making-of/drift/) (Mario-Kart-tier thresholds),
> [sim-render/](../making-of/sim-render/) (two-clocks interpolation),
> [steam/](../making-of/steam/) (Tauri → Electron port + live
> WebGPU/WebGL2 probe). Ships at `/making-of/` from the same Vite
> multi-page build; linked from the main menu (PICK YOUR FORMAT →
> **MAKING OF**). Tuck + drift demos drove two pure-leaf extractions
> ([tuck-curve.ts](../src/game/systems/tuck-curve.ts),
> [drift-tiers.ts](../src/game/systems/drift-tiers.ts)) re-exported
> from their systems so existing call sites + unit tests are
> unchanged.
>
> **Perf HUD — render backend + GPU driver + Deck-profile state.**
> [src/engine/render/perf-hud.ts](../src/engine/render/perf-hud.ts)'s
> static-diagnostics block now surfaces the live render backend
> (WebGPU / WebGL2), the GPU adapter / driver string, and whether the
> Steam Deck detection fired + which signals triggered it. Toggled by
> `?perf=1` or Backquote.
>
> **Water LOD — center-mesh doubling + cross-fade.** A
> [water LOD test track](../public/tracks/water-test.json) shipped
> alongside two material fixes: the center water mesh is now doubled
> (inner detail + outer LOD tile), cross-fades into the outer ring
> with a Gerstner-aware skirt (the skirt rides the wave field instead
> of being a flat ring at z=0), and the outer + skirt now sample a
> shared planar-reflection RT (no more two RTs fighting). Bonus
> material fixes: reflection contribution fades to zero past 500 m,
> Fresnel sky tint picked up at grazing angles, haze caps reconciled
> with the fresnel coefficient so the horizon doesn't double-count.
>
> **Rider editor.** `?rideredit=1` opens a turntable scene where each
> rider bone can be reshaped (capsule / box / sphere / cylinder / cone),
> recoloured, and the seated pose adjusted (per-joint angles + seat
> rotation). Live preview, Load / Save / Export, persistence in
> localStorage. The shipped defaults read from
> [src/engine/render/rider-appearance.ts](../src/engine/render/rider-appearance.ts);
> [rider-pose.ts](../src/game/systems/rider-pose.ts) reads the same
> `RIDER_POSE_TUNING` object the editor writes, so an in-race pose
> change is one reload away.
>
> **WaveRider props.** New kinematic-position floating prop type
> ([src/game/entities/wave-rider.ts](../src/game/entities/wave-rider.ts),
> system in [src/game/systems/wave-rider.ts](../src/game/systems/wave-rider.ts))
> for buoys + logs that ride the wave surface but bikes can't push.
> Authored via track JSON; `?waveriders=1` scene
> ([src/boot/wave-rider-mode.ts](../src/boot/wave-rider-mode.ts))
> is a validation harness with a live tuner UI.
>
> **Input navigability convention — PR #200, locked.** Closes a
> recurring nav-gap class: post-race + cup-results + Settings-over-menu
> + Rebind-over-Settings + MP lobby all reachable on controller and
> touch, not just mouse. New
> [`isAnyOverlayShown()`](../src/engine/input/menu-gamepad.ts) helper
> + parking convention pin in
> [v1-work-breakdown.md § Convention — input navigability](./v1-work-breakdown.md#convention--input-navigability)
> so future overlays can't reopen the regression.
>
> **Blender scatter — biome palettes + scatter strokes.** Proposal A/B
> shipped per-zone biome-palette scatter (`tools/blender/hoverbike_addon/scatter.py`,
> `biome_palette.py`) — an Empty parents a `HV_Scatter` GN mesh that
> reads a Source Collection (palms / rocks / urban kit), emitted at
> export as `EXT_mesh_gpu_instancing`. Proposal C added
> [scatter strokes](../tools/blender/hoverbike_addon/scatter_stroke.py) —
> a curve bounds a per-prop scatter line composed additively on top of
> the palette zones. Material follow-ups: `mat_terrain_main` is now
> version-stamped so legacy .blends auto-upgrade on open
> (`auto-upgrade mat_terrain_main on .blend open`), and the addon ships
> vertex-color + material ops for hand-rolled terrain authoring.
>
> **Last updated: 2026-05-21** — Phase γ kicks off
> [`docs/level-visual-quality-research.md`](./level-visual-quality-research.md):
> four biome prop kits land alongside throwaway test scatter on
> Shibuya / Kilauea / Marina Bay / Angkor.
>
> [`seed_props_library.py`](../tools/blender/seed_props_library.py) now
> builds **19 prop archetypes** (5 legacy + 14 new):
>
> * **Urban** (Shibuya/Marina Bay/Liberty) — `prop_lamp_post`,
>   `prop_antenna_mast`, `prop_vent_stack`, `prop_ac_unit`,
>   `prop_signage_panel`.
> * **Industrial** (Marina Bay) — `prop_container`, `prop_oil_drum`,
>   `prop_mooring_bollard`.
> * **Volcanic** (Kilauea) — `prop_basalt_boulder`, `prop_ash_heap`,
>   `prop_scorched_stump`.
> * **Jungle** (Angkor) — `prop_fern_clump`, `prop_mossy_boulder`,
>   `prop_fallen_pillar`. Fern uses `mat_foliage_fern` so the runtime
>   sway shader picks it up automatically.
>
> Each new collection: Asset-Browser-marked under its biome catalog
> (4 new UUIDs), tagged `scatter_source=True`, placeholder material
> with `mat_prop_*` or `mat_foliage_*` naming. All under 200 verts
> except `prop_mossy_boulder` (522v — on the trim-pass list).
>
> Test scatter wired on 4 tracks to verify each kit flows end-to-end:
> Shibuya gets 272 urban instances, Marina Bay 396 industrial, Kilauea
> 442 volcanic, Angkor 391 jungle. Combined with Phase β step 7 the
> seven-track scatter footprint sits at **~3273 scattered instances**
> across the 8 tracks now carrying scatter zones. Placement on the
> Phase γ tracks is **throwaway** pending the level rework; the
> archetypes + the per-biome catalog structure are the durable
> deliverable.
>
> Still missing: Venetian (Doge's) and Waterpark (Aqualand) prop kits.
> Liberty Drowned has the urban kit available but isn't wired yet.
>
> **Last updated: 2026-05-21** — Phase β step 7 of
> [`docs/level-visual-quality-research.md`](./level-visual-quality-research.md):
> rock-scatter rolls onto the three remaining tropical tracks. The Maw
> gets 5 zones (802 rocks flanking the three arches), Hatteras Light
> gets 4 zones (417 rocks outside the racetrack oval), Cape Town
> Drift gets 4 zones (478 rocks on the harbor/Atlantic boundary). All
> three use `prop_rock` rather than `prop_palm` — the racing lines
> stay at sea level on open water, so palms would float; sea-stacks
> just above the waterline read at race-pace. The South Beach helpers
> lifted into [`tools/blender/scatter_lib.py`](../tools/blender/scatter_lib.py)
> so per-track scatter is now ~5 lines (declare `SCATTER_ZONES`, call
> `drop_scatter_zones(scene, PROPS_LIBRARY, ZONES)` from `augment_scene`).
> End-to-end verified: all four tracks export with
> `EXT_mesh_gpu_instancing` populated (2160 total scattered rocks/palms
> across the Reef Cup tropical biome), and `pnpm gen:tracks:validate`
> shows the-maw/hatteras-light/cape-town-drift/south-beach-sunken all
> at 0 errors. Phase β fully complete; Phase γ (biome prop kits for
> non-tropical tracks) is the next leverage slice.
>
> **Last updated: 2026-05-19** — Blender addon UX rework lands
> alongside Phase A gap 7 + Phase F of
> [`docs/v1-asset-pipeline-plan.md`](./v1-asset-pipeline-plan.md). The
> addon pass: new top-bar Hoverbike menu (View3D header, BlenderGIS-style)
> holding every operator, N-panel sub-panels go selection-driven so the
> sidebar only shows the tools that match the active object, Shift+W
> opens a quick pie of the eight most-used actions, sea level decouples
> from `water_volume_main` (the scene prop `hoverbike_water_height` is
> the canonical source — legacy volumes migrate lazily; the empty stays
> only for `wave_height` / `wave_freq` overrides), and a new
> *Add Island Terrain* operator drops the procedural `HV_Island`
> template into the current scene without requiring a fresh .blend.
> Preview collections (gate, water, racer) reuse their datablock across
> rebuilds so Outliner collapse-state sticks, and wave-zone gizmos now
> render as wireframe. See *Authoring — addon UX rework + water
> decoupling + island spawn (2026-05-19)* below for details.
> 
> New [`src/game/ai/pump-hints.ts`](../src/game/ai/pump-hints.ts) walks
> each AI spline against the track's `wave_zone_NN` empties and flags
> indices inside any zone whose `heightMult > 1.2` (the threshold gap 7
> calls out). The AI controller reads the hint set + samples local
> surface vy each tick: when the AI's cursor sits on a hint AND the
> swell is rising hard enough, it fires a 100 ms nose-up pump burst
> (the same `intent.pitch` input the player taps with E), then locks
> out for 500 ms — matching the player wave-pump observer's cooldown.
> Per-difficulty tuning (`pumpVyThreshold` + `pumpPitchStrength` in
> `DIFFICULTY_TUNING`): Casual disables pumps via `Infinity`,
> Standard fires at vy ≥ 1.5, Hard fires at vy ≥ 0.6 with a stronger
> pitch flick. **Phase F** — bike lineup grows 3 → 5 with Scout
> (heavyweight, soft hover spring + lowest surfaceFollow → punishing
> pump timing + biggest launch) and Sparrow (lightweight, stiffest
> spring + highest surfaceFollow → forgiving pump). Player bike now
> tints its livery to the variant's `bodyColor` at clone time so
> 5th-bike variants reading from a shared base GLB (Sparrow → Racer
> until a dedicated `.blend` lands) render visibly distinct. New
> `pnpm gen:bike-thumbs` captures 480×270 thumbnails for every
> variant via a `?viewer=<id>&thumb=1` Playwright route; the two
> "Coming Soon" bike slots are gone from the picker. 693/693 unit
> tests passing (20 new — 11 pump-hints, 2 difficulty pump fields,
> 7 bike-variants).
>
> Recent landed work (one-liners — `git log` carries the full story):
> hover yaw-coupling fix (no nose pull along lateral slopes),
> Blender scatter through `EXT_mesh_gpu_instancing` (scatter shows
> palms not just empties), rider editor (primitives + colours + seated
> pose), `mat_terrain_main` auto-upgrade on .blend open, scatter
> strokes (Proposal C — curve-bounded scatter), biome-palette scatter
> (Proposal A + B), vertex-color + material ops for hand-rolled
> terrain, path-wear bake fixes (Z-up + sparse-sampling +
> narrow-defaults), Steam Linux Runtime survival kit (`--no-zygote`,
> Vulkan/ANGLE flags gated to Linux, libwayland strip), Linux Steam
> depot dropped (Windows-only depot, Proton handles the Deck), drift
> mini-turbo (MK-style mini-turbo with MT/SMT/UMT tiers + inside-drift
> archetypes + colored sparks + skid audio + HUD tier badge + AI drift
> + DRIFT tutorial beat + Drift Practice Range), surface-type
> registry (per-collider lateral grip — ice / sand / metal / water /
> default), tuck sweet-spot (snowboarder lean folded into nose-down
> pitch — meter + slipstream VFX), tricks (geometric pop-based window
> off lips / ramps / ledges / embankments), hover dive/release-kick
> + bow/stern spring curves + air-PD revert, water LOD + cross-fade
> + skirt-on-waves + reflection fixes, Electron desktop wrapper
> (replaced Tauri — real WebGPU in Steam Linux Runtime), perf-HUD
> render-backend + GPU-driver + Deck-profile diagnostics, six-chapter
> making-of microsite (real-sim-importing demos), input-navigability
> convention (post-race + stacked overlays controller/touch-navigable,
> PR #200), Phase γ biome prop kits (19 prop archetypes across urban /
> industrial / volcanic / jungle), Blender addon UX rework (top-bar
> menu + selection-driven N-panel + pie + island-terrain spawn +
> sea-level decoupled from water_volume), runtime lava-river shader,
> swinging-landmark kinematic colliders, Phase E Sprint 3 (Drowned
> Cup — Aqualand, Angkor Drowned, Liberty Drowned; v1 lineup
> complete), Phase D Sprint 2 polish, Polish-QA kickoff (Perf HUD +
> Accessibility tab + cross-browser Playwright projects), Phase D
> Sprint 2 (Open Sea + Continental Cups), v1 asset-pipeline foundation
> + Reef Cup, Multiplayer convention row closed, wave-line shimmer,
> Controls rebind tab, Cup wiring, Time Trial mode, Foundation Systems
> 5/5, v1 menu cathedral + wave-pump.
>
> Live build: <https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app> —
> every push to `main` auto-deploys.

This doc captures the build's current state, controls, known issues, and next steps. It complements [product-plan.md](./product-plan.md) (vision + MVP scope) and [implementation-plan.md](./implementation-plan.md) (architecture + milestone breakdown).

## What works today

- **Out of bounds — return-to-course autopilot + the great white** ([docs/out-of-bounds-design.md](./out-of-bounds-design.md)). Stray too far off the racing line and a Battlefield-style **RETURN TO COURSE** popup + countdown fires, autopilot steers you back, and you forfeit race credit (recorded as a **DNF**). The boundary is a single **leash** — 3D distance to the nearest `main` AI-spline sample — with the soft wall at **1.5× the per-track corridor half-width** (median buoy distance to the line; the `waveRiderBuoys` are the channel walls) and a hard wall at 2.5×; 3D distance also catches a vertical joyride "to the moon" while legit vertical track features stay safe (the line climbs there too). The sim state machine (`in → warn → brace → lethal{hit|nearmiss}`, [src/game/systems/out-of-bounds.ts](../src/game/systems/out-of-bounds.ts)) is deterministic + player-only; the loop reuses the existing test-mode seam for the autopilot handoff (releases the instant you touch the controls) and converts the forfeit into a DNF at the finish. In **Shark** mode the lethal phase is an **AirJaws great white** ([shark.ts](../src/engine/render/shark.ts) + [shark-sequence.ts](../src/engine/render/shark-sequence.ts)) that breaches from the depths, ejects the rider ragdoll (reusing `launchRider`), and carries the bike under in a death-cam before you respawn on the line — or, if you were recovering in time, breaches just wide for a **near-miss** and you race on. Settings → Gameplay → **"Out of bounds"** (Off / Autopilot / Shark) + **"OOB grace timer"** (Short / Normal / Long). Single-player Race + Time Trial; multiplayer + tutorial opt out. The procedural shark is art-upgradeable to a sculpted GLB later.
- **Making-of site** ([making-of/](../making-of/)). Six illustrated chapters with playable Three.js demos that import the *real* sim so they can't drift from shipped code: wave field, buoyancy (the 4-probe footprint), feel tuning (the tuck sweet-spot curve), the drift mini-turbo tiers, the sim/render split (a two-clocks interpolation demo), and the Tauri→Electron Steam port (a live WebGPU/WebGL2 capability probe). Ships at `/making-of/` from the same Vite multi-page build and is linked from the main menu (PICK YOUR FORMAT → **MAKING OF**). The tuck + drift demos drove two pure-leaf extractions ([src/game/systems/tuck-curve.ts](../src/game/systems/tuck-curve.ts), [src/game/systems/drift-tiers.ts](../src/game/systems/drift-tiers.ts)) re-exported from their systems so existing call sites and unit tests are unchanged.
- **Drift — Mario-Kart-style mini-turbo with three tiers + bike archetypes + AI + tutorial.** Hold Z (or LB) + steer left = drift left; hold C (or RB) + steer right = drift right. Release after a charged hold to fire the tier 1/2/3 mini-turbo boost (blue MT / orange SMT / purple UMT). The system overloads the existing trick buttons — a flat-ground press still fires a small hop (MK's drift initiator tell), drift only commits when the steer is committed past `STEER_COMMIT_THRESHOLD = 0.1` in the matching direction. Charge thresholds in [src/game/systems/drift-tiers.ts](../src/game/systems/drift-tiers.ts) are 0.6 s / 1.4 s / 2.4 s; boost multipliers 1.45× / 1.75× / 1.95× over `BOOST_DEFAULT_MUL`; durations 1.0 s / 1.6 s / 2.3 s. The boost fires the same one-shot `BoostEffect` boost pads use so it stacks multiplicatively with the wave-pump boost meter (chain a trick → drift for the speedrun reward). During drift: lateral drag drops to 35% of baseline (visible slide), forward thrust unchanged, yaw replaces the base steer torque with a speed-tapered auto-turn-in bias (`DRIFT_YAW_BIAS_FRAC = 0.45`) + full-authority counter-steer (`DRIFT_STEER_FRAC = 0.65`) so steering INTO the drift tightens the line and counter-steering OPENS it (no fixed 180° spiral). The low-speed bias taper (`DRIFT_YAW_SPEED_REF = 8 m/s`) kills the auto-rotate below the floor so a bleed-out drift can't spin out. Inside-drift archetypes (`BikeStatsData.driftStyle: 'inward'` — Sparrow, Stunt) get a 250 ms initial-cut spike (`INWARD_INITIAL_BIAS_MUL = 1.2`) then a wider tail (`INWARD_TAIL_BIAS_MUL = 0.8`) — sport-bike feel against the outside-drift default (Cruiser, Racer, Scout). Cancel conditions: button released, ungrounded > 300 ms, or brake > 0.5. Anti-snake: 0.6 s minimum hold before charge begins, 0.25 s release cooldown. AI activates drift on sharp upcoming corners via [decideAIDrift](../src/game/systems/drift.ts) — Casual disabled, Standard caps at SMT on ≥ 0.033 1/m curvature, Hard reaches UMT on ≥ 0.020 1/m. The default tutorial script grows a **DRIFT** beat between WAVE PUMP and ANTI-GRAV (clears on the first charged release, 25 s escape hatch). HUD tier badge ([src/engine/render/drift-tier-hud.ts](../src/engine/render/drift-tier-hud.ts)) sits next to the boost meter, color + label swapping MT → SMT → UMT with a tier-up pulse on each upgrade. Three layered drift-spark pools at the outside-rear corner (blue MT → orange SMT → purple UMT, stacked when a higher tier is live). Skid-audio loop (`audio.driftSkid`, band-passed noise at 2.6 kHz scaling with speed) + per-tier release whoosh (`audio.driftBoost`, bell pitch A5 / C#6 / E6). Rider banks 13°→31° into the drift (`driftLeanTarget` in [rider-pose.ts](../src/game/systems/rider-pose.ts)). Camera rolls 5° / 7° / 9° by tier. Settings → Gameplay → **"Drift assist"** (Full / Subtle / Off) gates sparks + audio + HUD + camera roll; the boost itself fires regardless so a frame-dropped whoosh never costs you the mini-turbo. **Drift Practice Range** dev test track ([public/tracks/drift-test.json](../public/tracks/drift-test.json), `?track=drift-test`, surfaced in the Dev Cup picker) walks every charge tier through symmetric corners + a boost-pad merge + ICE/SAND patches that demonstrate the surface registry. Full design + tuning rationale in [docs/drift-deep-dive.md](./drift-deep-dive.md); pure-helper extraction in [drift-tiers.ts](../src/game/systems/drift-tiers.ts) is what the making-of microsite's Drift chapter imports.
- **Surface-type registry — per-collider lateral grip.** Each static collider can carry a `SurfaceType` (`default` / `asphalt` / `metal` / `sand` / `ice` / `water`) keyed in `engine/sim/surface-types.ts`'s `SurfaceRegistry`. The `lateralGripMul` from `SURFACE_PROFILES` scales the bike's lateral drag in BOTH normal driving and drift, so an ice patch feels coherent whether or not you're sliding (the alternative — drift-only grip change — would have ice feel grippy when you're trying to hold a line and slippery the instant you press drift, a "treacherous when committed" feel that doesn't match real-world expectations). Profile values: ice 0.35× (very slick — long, loose drifts), sand 0.70× (washes out — wide, hard to hold), default/asphalt 1.00 (baseline), metal 1.25× (clingy — tight, snappy drifts), water 1.00 (neutral — water feel stays owned by the `isWater` branch in `hover.ts`). **Design guard:** `default` is byte-identical to pre-registry behaviour, so every existing track (none currently tag surfaces) reads the same. Authoring: JSON `Prop.surface` field for prop colliders (props.ts tags at creation), GLB track meshes pick up an optional `surface` userData extra (glb-track.ts validates against the enum, unknown values silently ignored). The hover center probe reads `hit.collider.handle` each tick, looks up the type, and writes `HoverState.surfaceType`. The Drift Practice Range demonstrates: an ICE patch on the west SMT sweep (extra-loose) and a SAND patch on the south ramp straight. Blender authoring UI for the GLB `surface` extra is the remaining follow-up; the runtime path is already wired. See [tests/unit/surface-types.test.ts](../tests/unit/surface-types.test.ts).
- **Tricks — geometric pop-based trick window.** Replaces the old velocity-gate model. The trick window in [src/game/systems/trick-hop.ts](../src/game/systems/trick-hop.ts) is now armed by the bike's *pose*, not a vertical-velocity threshold: the moment the bike leaves its fully-planted stance — nose lifting off a bump / lip / ramp crest while the base is still down, a clean full takeoff, OR riding a meaningful slope at speed (a kicker up a ramp / sandbar, or a drop off a ledge / embankment, where the bike follows the surface so no pop fires on its own) — the window opens and stays open the whole airtime, closing only when the bike re-plants. Any rising-edge trick press fires once per airtime. The bow/stern hover probes' chatter-debounced per-end contact flags (`HoverState.noseGrounded` / `baseGrounded`) make the pop a first-class signal so lips and crests register before the center probe would. Eligibility still requires the launch be surface-driven (not the bike's own courtesy hop — `hopLockoutActive`) and ridden with intent (speed ≥ `MIN_SPEED_FRAC` × top-speed, throttle ≥ `MIN_THROTTLE`); flat ground naturally rejects parked / coasting tricks. A 200 ms pre-press buffer holds a button mashed *before* the bike's nose pops so the press still lands when the window actually opens. See [tests/unit/trick-hop.test.ts](../tests/unit/trick-hop.test.ts).
- **Hover polish — dive kick, release kick, bow/stern spring curves, yaw-coupling fix, climb-assist gate.** A held nose-down lean (`intent.pitch < 0`) now follows a rate-limited dive-then-level curve in [hover.ts](../src/game/systems/hover.ts) — pitch climbs to a dive limit then settles back, so a deep tuck on water no longer flips the bike. On release, a brief `dive-kick` boost on the bow spring leads the recovery — nose pops first, body follows. Stern spring's boost-on-rise mirrors the bow curve so launches feel symmetric. Bow spring stiffness curve is soft at the top and stiff past 1.0 at the bottom, so a clean wave rebound springs back but heavy landings absorb. Air branch reverts to pure free physics (no PD) — air control is throttle + pitch only. The latest commit (`20a5547`) kills a sneaky yaw-coupling term that pulled the nose along lateral slopes, so cornering across a bank no longer drags the bike sideways. Climb-assist (the small upward force that helps a forward-throttling bike crest a ramp) is now gated on forward throttle so coasting bikes don't ride uphill on their own.
- **Water LOD + cross-fade + Gerstner skirt** ([public/tracks/water-test.json](../public/tracks/water-test.json) is the dev fixture with markers at the LOD transitions and a colorize toggle). The center water mesh now ships in *two* halves — an inner detail mesh and an outer LOD tile — that cross-fade across their shared boundary so the seam never reads as a hard line. The far-rim skirt rides the Gerstner wave field instead of being a flat ring at z=0 (so distant horizon water has the same swell as foreground), and the haze ramp drops off so the skirt doesn't blow out at grazing angles. Material fixes shipped in the same window: outer + skirt now sample a *shared* planar-reflection RT (no more two RTs fighting); reflection contribution fades to zero past 500 m so far horizon stays clean; outer + skirt pick up the Fresnel sky tint at grazing; haze caps + Fresnel coefficient reconciled so the horizon doesn't double-count.
- **Electron desktop wrapper (replaces Tauri).** The Steam Deck / desktop wrapper is now Electron (`electron/main.cjs`). Bundles its own Chromium so the game gets real WebGPU inside the Steam Linux Runtime container — the Tauri/WebKitGTK shell was stuck on WebGL2 fallback and didn't launch through the Steam runtime on the Deck at all. Build commands: `pnpm build:deck` (Linux tree on any Linux host or WSL), `pnpm build:windows` (NSIS installer + tree on Windows host), `pnpm electron:run` (quick local build-and-launch). Steam-Linux-Runtime survival kit: launch wrapper [`electron/hoverbike-launch.sh`](../electron/hoverbike-launch.sh) sets the right env, `--no-zygote` clears the sniper namespace crash, `--enable-unsafe-webgpu` + `--use-angle=vulkan` gated to Linux only (Windows-on-Proton black-screens with the ANGLE/Vulkan flag, but Linux Wayland needs the Vulkan-through-ANGLE path); bundled `libwayland-*` stripped from the AppImage (caused Wayland EGL abort). Linux Steam depot has been dropped — only Windows depot uploads now, Proton handles the Deck (simpler than maintaining a Linux depot in parallel). Perf HUD reports the live render backend + GPU driver string + whether the Deck profile applied. See [docs/desktop-builds.md](./desktop-builds.md) + [docs/steam-deck.md](./steam-deck.md).
- **Perf HUD — render backend + GPU driver + Deck-profile diagnostics.** [src/engine/render/perf-hud.ts](../src/engine/render/perf-hud.ts) grew a static-diagnostics block alongside the live frame stats. New rows: render backend (WebGPU / WebGL2 — sourced from the real adapter probe), GPU adapter / driver string (Chromium-only via `WEBGL_debug_renderer_info` for WebGL2; the new `getAdapterInfo()` for WebGPU), Steam Deck profile applied (Y / N) + which detection signals fired (UA / 1280×800 viewport / Steam virtual gamepad). Useful when triaging Deck-specific issues — a glance at the HUD says "yes the Deck profile kicked in, yes you're on WebGPU, yes ANGLE/Vulkan is on the command line". Toggled via `?perf=1` URL param or Backquote keyboard shortcut.
- **Rider editor** ([src/boot/rider-editor-mode.ts](../src/boot/rider-editor-mode.ts), `?rideredit=1`). Live turntable scene where each rider bone can be reshaped (capsule / box / sphere / cylinder / cone), recoloured, and the seated pose adjusted (per-joint angles + seat rotation). Live preview on the static bike, Load / Save / Export to JSON. Persistence in localStorage. The shipped defaults read from [src/engine/render/rider-appearance.ts](../src/engine/render/rider-appearance.ts); the in-race [src/game/systems/rider-pose.ts](../src/game/systems/rider-pose.ts) reads the same `RIDER_POSE_TUNING` object the editor writes, so a pose change is one reload away from the racing rider.
- **WaveRider props** ([src/game/entities/wave-rider.ts](../src/game/entities/wave-rider.ts) + [system](../src/game/systems/wave-rider.ts) + [components](../src/game/components/wave-rider.ts)). Kinematic-position floating prop type for buoys (cylinder, ≈ 0.9 m tall) and logs (cylinder, ≈ 1.2 m long) that ride the wave field — bikes collide but can't push. Authored via track JSON; track meshes can carry them as floating obstacle/landmark dressing. `?waveriders=1` boot mode ([src/boot/wave-rider-mode.ts](../src/boot/wave-rider-mode.ts)) is a validation scene with a live tuner UI for the prop tuning constants.
- **Input navigability convention** (PR #200, [§ Convention — input navigability](./v1-work-breakdown.md#convention--input-navigability)). Locks the third leg of the definition-of-done convention: every interactive surface must be operable by keyboard, controller, AND touch. New [`isAnyOverlayShown()`](../src/engine/input/menu-gamepad.ts) helper + parking convention so a base-layer poller parks while a higher overlay is up (was the bug class that left controller nav silently broken on Settings-over-menu, Rebind-over-Settings, and the multiplayer lobby). The post-race + cup-results screens grew a topmost-container poller; the in-race touch UI gets `body.touch-ui-hidden` on finish so its joystick doesn't eat taps meant for the result buttons. 11-case regression-pin suite in [tests/unit/menu-gamepad.test.ts](../tests/unit/menu-gamepad.test.ts).
- **Tuck — the snowboarder's downhill duck, folded into the nose-down lean (no dedicated button).** The bike tucks when the player leans the nose down (Q / push stick forward — the same `intent.pitch < 0` the dive-aid reads, so tuck and dive are one gesture). The payoff is a *sweet spot*, not a floor-it: `tuckFactor()` ([src/game/systems/hover.ts](../src/game/systems/hover.ts)) ramps 0→1 as the nose-down lean climbs to `TUCK_SWEET_SPOT = 0.8`, then winds back through zero to `TUCK_SCRAPE_FLOOR = -0.5` at full deflection — where the dive-aid's ride-height drop (`DIVE_HOVER_HEIGHT_MIN_MUL`) already has the belly skimming the deck. The signed factor interpolates two per-bike stats off 1.0: `tuckSpeedBoost` (peak top-speed cap ×1.15, stacks with boost) and `tuckDragMul` (peak lateral drag ×0.5). So a *feathered* lean down a slope or wave face is fastest — the raised cap lets slope-momentum / throttle convert into real speed past the base top-speed — while *burying* the nose over-tucks: the now-negative factor pushes the cap below base and drag above it, on top of the literal belly-scrape from the lowered ride height. Grounded / over-water only (airborne pitch stays a free dive — see the air branch). The reward is structural (lean right and the hill pays you) rather than a button you hold. New unit suite [tests/unit/tuck-sweet-spot.test.ts](../tests/unit/tuck-sweet-spot.test.ts) pins the curve shape (ramp, peak, zero-crossing, scrape floor). **VFX:** a `tuckStream` particle pool ([src/engine/render/fx/index.ts](../src/engine/render/fx/index.ts)) sheds cool cyan slipstream streaks off the bike's shoulders, with both emission rate *and* sprite size scaled by `Math.max(0, tuckFactor)` — so the fan thickens as you ride the sweet spot and vanishes entirely on an over-tuck (negative factor). Gated to grounded/over-water frames (where the physics pays out) and capped by a new **Settings → Gameplay → "Tuck slipstream VFX"** select (`playerSettings.tuckVfxIntensity` — Full / Subtle / Off, scalar in `TUCK_VFX_SCALAR`). **Meter:** because tuck has no button and the payoff is subtle off-slope, a `#hud-tuck` accuracy gauge ([src/engine/render/tuck-hud.ts](../src/engine/render/tuck-hud.ts)) makes the curve legible — a horizontal bar fills with the raw lean, a notch marks the sweet spot, and the colour + status word (`LEAN IN` / `SWEET!` / `EASE OFF` / `SCRAPING`) + live cap-bonus % report how well it's paying off. Fades in only while tucking; **Settings → Gameplay → "Tuck meter"** toggle (`playerSettings.tuckMeter`, default on).
- **Bike lineup grows to five — Scout + Sparrow ship (Phase F of [docs/v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md)).** `BIKE_VARIANTS` in [src/game/bikes/variants.ts](../src/game/bikes/variants.ts) now exposes the v1 target of five archetypes: Cruiser / Racer / Stunt + the new **Scout** (heavyweight) and **Sparrow** (lightweight). Scout is heaviest (mass 220) with the softest hover spring (22 vs default 34) and lowest surfaceFollow (0.4) — the soft spring is what makes its wave-pump timing "punishing" per the design-targets: the chassis reacts late to the crest, so an early E flick is wasted and a late one launches off air; once airborne, the inertia carries through chop. Sparrow is lightest (mass 80) with the stiffest spring (38) + highest surfaceFollow (1.05) — the bike springs off any crest with a wide pump-input tolerance window, the "forgiving + further launch" pole of the lineup. Bike-select picker drops both "Coming Soon" placeholder slots. Player bike render now passes `tintLivery: variantColor` to `cloneLoadedBike` ([src/engine/render/render-systems.ts](../src/engine/render/render-systems.ts)) so variants sharing a base GLB (Sparrow → racer.glb until a dedicated Blender source lands) read with the right colour. New `pnpm gen:bike-thumbs` ([tools/gen-bike-thumbs.mjs](../tools/gen-bike-thumbs.mjs)) drives a `BIKE_THUMBS=1`-gated Playwright spec ([tests/e2e/gen-bike-thumbnails.spec.ts](../tests/e2e/gen-bike-thumbnails.spec.ts)) that hits `?viewer=<id>&thumb=1` (suppressed HUD + grid + tighter camera in a new `thumbMode` branch of [src/viewer/bike-viewer.ts](../src/viewer/bike-viewer.ts)) and captures 480×270 JPGs per variant into `public/assets/bikes/<id>-thumb.jpg`. The viewer's render loop now flips `document.body.dataset.bikeViewerReady = '1'` on the second rendered frame so the spec has a deterministic capture gate. 7 new bike-variant tests cover the 5-archetype roster + Scout/Sparrow tuning intent.
- **AI pumps where the wave zones tell them to (Phase A gap 7 of [docs/v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md)).** Closes the last open Phase A gap. New pure module [src/game/ai/pump-hints.ts](../src/game/ai/pump-hints.ts) walks each AI spline against the track's `wave_zone_NN` list and flags indices inside any zone whose `heightMult > 1.2` (the default threshold gap 7 spells out — "derive automatically from spline proximity to `wave_zone_NN` empties with `height_mult > 1.2`"). The flag set is built lazily via a `WeakMap<Track, …>` cache, mirroring the existing `SPLINE_INDEX` cache in [src/game/systems/ai-control.ts](../src/game/systems/ai-control.ts) so it GC's alongside the spline cache. The AI controller now also takes the wave field as a parameter; per tick, if the AI's current spline cursor is on a hint AND the smoothed surface vy under the bike clears the difficulty's threshold AND speed ≥ 45% of top-speed (matching the player wave-pump observer's `minSpeedFrac`), it sets `intent.pitch = pumpPitchStrength` for 100 ms — the same nose-up input a player taps with E — then locks out for 500 ms (matching the player observer's `cooldownMs`). Per-difficulty tuning lives in [src/game/ai/difficulty.ts](../src/game/ai/difficulty.ts): Casual disables pumps entirely (`pumpVyThreshold = Infinity` → branch short-circuits, no per-tick cost), Standard fires at vy ≥ 1.5 with a 0.5 pitch (mirrors the player observer's `minVy`), Hard fires at vy ≥ 0.6 with a stronger 0.8 pitch. 11 new pump-hint unit tests cover empty zones, OBB inside/outside, blend-radius soft edge, low-heightMult ignore, multi-zone union, and yawed OBB orientation; 2 new difficulty-tuning tests pin the per-tier pump values inside the player observer's vy band.
- **Drowned Cup tracks build + export end-to-end — v1 lineup complete** (Phase E Sprint 3 of [docs/v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md)). `pnpm seed:track-aqualand`, `pnpm seed:track-angkor-drowned`, `pnpm seed:track-liberty-drowned` each materialise a `tracks-src/<id>.blend` + `public/assets/tracks/<id>.glb` (2.7–8.5 MB) + `public/tracks/<id>.json` + hero/thumb JPGs. Sprint 3 was author-by-three-parallel-agents-in-worktrees, integrated sequentially. **Aqualand** is the special-case bespoke track — no biome template, the pool basin + lazy-river curbs + half-pipe slide + lifeguard towers + main concourse are inline `bmesh` primitives layered on top of `template-island` (the brief's "doubly drowned" waterpark), and the hero gameplay surface is the **Tsunami wave zone** (`surgePeriodS=30`, `surgeAmplitude=4.0` — periodic flood every 30 s over the lowest concourse, the wave-mastery pillar's most explicit appearance in v1). **Angkor Drowned** layers a library-linked `tower_cylinder_spiral` + 16 `carved_face_block` instances + jungle dressing onto template-alpine, with a `PROFILE_TUBE` helix anti-grav climb around the central spire. **Liberty Drowned** is the v1 finale — template-downtown (nyc) with a hand-blocked low-poly Liberty silhouette (pedestal + body cone + head + broken torch arm + tablet, ~121 v / 156 f, ~70 m total) inline via `bmesh`, library-linked `drowned_facade_nyc` Manhattan rooftops + a stretched `arch_ruin` reading as sagging Brooklyn Bridge, and **both anti-grav segments shipped**: the torch-arm Möbius via `PROFILE_BANKED_STRIP` with `bp.tilt` rising 0 → π for the half-twist, and the crown interior via a closed cyclic `PROFILE_TUBE` loop at head altitude. All 3 lint clean (0 errors / 0 warnings — cleanest sprint yet). Tracks-catalog tiles for the three flipped to `status: 'ship'` so the Drowned Cup unlocks via the existing `shipCupRaces('drowned')` plumbing. Trailer shots: **Liberty's silhouette** under `nyc_sunset` sky framed by the new `camera_hero` is v1's last shot.
- **Open Sea + Continental Cup tracks build + export end-to-end** (Phase D Sprint 2 of [docs/v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md)). `pnpm seed:track-the-maw`, `pnpm seed:track-shibuya-submerged`, `pnpm seed:track-kilauea-crown`, `pnpm seed:track-marina-bay-7`, `pnpm seed:track-doges-drift` each materialise a `tracks-src/<id>.blend` + `public/assets/tracks/<id>.glb` (2.5–8.5 MB) + `public/tracks/<id>.json` + hero/thumb JPGs. Sprint 2 was author-by-five-parallel-agents-in-worktrees, integrated sequentially because the local Blender install is single-tenant. Each seed mirrors the Reef Cup pattern: load template → reshape spline → build road → augment with library-linked landmarks + wave zones + (optional) anti-grav curve + pickups + boost pads + camera_hero → re-export GLB/JSON. All 5 pass `pnpm gen:tracks:validate` lint (0 errors); 4 carry advisory spline-clip warnings against downtown-template building footprints (polish item for the art-tuning pass). Hero set-pieces materialised: **The Maw**'s 3 arches over open Pacific with the directional-swell wave zone at the centre; **Shibuya**'s Cocoon Tower wall-ride; **Kilauea**'s banked caldera-rim anti-grav ribbon + library-linked lava waterfall; **Marina Bay 7**'s 5-crane gauntlet with out-of-phase swing periods + beached supertanker deck shortcut; **Doge's**' Campanile climb + Rialto under-thread + swinging bell.
- **Reef Cup tracks build + export end-to-end** (Phase C Sprint 1 of [docs/v1-asset-pipeline-plan.md](./v1-asset-pipeline-plan.md)). `pnpm seed:track-sandbar`, `pnpm seed:track-south-beach-sunken`, `pnpm seed:track-hatteras-light`, `pnpm seed:track-cape-town-drift` each materialise a `tracks-src/<id>.blend` + `public/assets/tracks/<id>.glb` (~8.5 MB) + `public/tracks/<id>.json` + 1280×720 hero JPG + 320×180 thumb JPG. The seeds start from `template-island.blend`, reshape the AI spline, build the road + curbs, snap to terrain, lint, then run a per-track augment pass that drops landmark instances (linked from `tracks-src/landmarks-library.blend`), wave-zone empties, anti-grav curve sweep (Hatteras corkscrew), camera_hero, pickup spawns, and boost pads — finally re-exporting the GLB + manifest. Tracks are open-in-Blender-ready for art tuning; runtime track-select tiles activate once each is flipped to `status: 'ship'` in the catalog.
- **v1 asset-pipeline foundation (Phase A + B).** 9 of 10 Phase A gaps shipped (deferred: AI pump-hint), Phase B landmark library extended with 7 archetypes. Five new `kind` values flow Blender → glTF → runtime (`horizon`, `wave_zone`, `emitter`, `antigrav_curve` authoring-only, `camera_hero` authoring-only). New addon modules: `horizon.py`, `wave_zone.py`, `emitter.py`, `antigrav_ribbon.py`, `sky_preset.py`, `thumbnail.py`. New runtime systems: `path-wear.ts`, `particle-system.ts`, plus extensions to `horizon-ring.ts`, `wave-field.ts`, `sky.ts`, `audio.ts`. CI lint `pnpm gen:tracks:validate` wired into the asset-pipeline workflow.
- **Wave-line shimmer overlay.** Forward-looking guidance: additive cyan discs hover on the water in a 7×3 fan ahead of the bike (6–36 m, ±~12.6°), each one's size + brightness driven by the live surface vy at that XZ. Reads `sampleSurface(waveField, x, z)` per marker — the same CPU field buoyancy uses — so the shimmer matches the swell that's actually going to lift the player. A small `WAVE LINE` chip on the reserved `#hud-wave-line` slot lights when the system is on, turns yellow on a strong lock (score ≥ 0.55). Settings → Gameplay → "Wave-line guidance" (Full / Subtle / Off) gates marker count + pip visibility (full always shows the chip; subtle hides it during lulls; off disables everything). Render-only — never writes sim state, no replay/determinism obligations. Closes the wave-mastery pillar's predictive half opposite the after-the-fact wave-pump signal. See [src/engine/render/wave-line-shimmer.ts](../src/engine/render/wave-line-shimmer.ts), [src/engine/render/wave-line-scoring.ts](../src/engine/render/wave-line-scoring.ts).
- **Controls tab — keyboard rebind, gamepad fire/boost rebind, sensitivity, deadzone, invert Y.** Settings → Controls has all five rows live and persisted. Rebind modal (`src/engine/menus/rebind-modal.ts` + `#rebind-menu` in `index.html`) opens per-mode, walks the 8 keyboard actions or 2 gamepad actions, and uses swap-on-assignment semantics from `src/engine/input/bindings.ts`: when key K is reassigned to action A, the previous holder of K receives A's old primary so every action stays reachable. Secondary slots (Arrows + RShift defaults) get cleared on collision so no key lives in two slots. Gamepad capture polls via `pollGamepadButtonPress` on rAF and intentionally skips LT/RT — the analog triggers drive throttle / brake and shouldn't capture as button presses. `playerSettings` now owns `keyboardBindings`, `gamepadBindings`, `gamepadSensitivity`, `gamepadDeadzone`, `invertCameraY`; the migrated `gamepadDeadzone` + `cameraInvertY` are removed from `devSettings` (and from the dev menu + `index.html` DOM) so the Controls tab is the single source of truth. `keyboard.ts` reads action state through the live table; `gamepad.ts` reads the player-facing deadzone and clamps `sensitivity × shaped` to [-1, 1] so >1 saturates earlier; `camera-look.ts` reads `invertCameraY` directly (default false matches the previous "push up = look up" feel). See [src/engine/input/bindings.ts](../src/engine/input/bindings.ts), [src/engine/menus/rebind-modal.ts](../src/engine/menus/rebind-modal.ts).
- **Cup mode wiring (placeholder).** Cup tile → cup-select → cup-tracks → bike-select → race; `?race=1&track=<first>&bike=<id>&cup=<cupId>` signals championship mode to the game loop. On dev builds two cup tiles light up: **Dev Cup** (browse-only — click a tile for a one-off race, unchanged from Step 0) and **Dev Placeholder Cup** (the new championship: lagoon → cliffside → big-bay, START CUP CTA in the lineup preview). Finish overlay rewrites NEXT to `NEXT RACE (n/m)` mid-cup and `CUP RESULTS →` on the last race; new `#cup-results` overlay shows a per-race points table + champion banner with `YOU · X/MAX PTS`. MK8-style points (15/12/10/9/8/7/6/5/4/3/2/1) live in `src/engine/cup-progress.ts` along with the sessionStorage-backed state (cup id, bike loadout, race lineup, per-race results). RETRY mid-cup preserves progress (results swap by trackId, pointer never un-skips); EXIT (finish-screen + pause-menu) clears it. The four ship cups carry `races: shipCupRaces(id)` so they activate the moment their tracks flip to `status: 'ship'` — no extra cup wiring required. See [src/engine/cup-progress.ts](../src/engine/cup-progress.ts), [src/engine/render/cup-results-screen.ts](../src/engine/render/cup-results-screen.ts).
- **Time Trial mode + ghost recording.** Mode tile lit (Race / **Time Trial** / Cup / MP / Tutorial). Picks track → bike → race; URL is `?race=1&track=…&bike=…&tt=1`. AI bike count clamps to 0, recorder runs solo + records `lap` events to its event stream, finish overlay slices the player's fastest lap and persists it to `hoverbike.ghosts.v1::<trackId>::<bikeId>` when it beats the existing ghost. On the next TT run with the same (track, bike) a translucent cyan ghost spawns at the start gate — its Transform is driven each frame by a `ReplayPlayer` running off the player's *current lap time* (not wall-clock), so the ghost is a real pacing reference. Crossing the start/finish line seeks the ghost back to t=0; if the ghost finishes its lap first it freezes at end-pose until the player catches up. See [src/engine/replay/best-lap-slice.ts](../src/engine/replay/best-lap-slice.ts), [src/engine/replay/ghost-state.ts](../src/engine/replay/ghost-state.ts), [src/game/systems/ghost-runner.ts](../src/game/systems/ghost-runner.ts).
- **v1 menu cathedral.** Cold boot routes through title → 5-tile mode-select (Race / Time Trial / Cup / Multiplayer / Tutorial) → track or cup or lobby → 5-slot bike-select → race. Race mode shows all 12 v1 ship tracks as disabled tiles with post-flood landmark blurbs + per-track gate labels; Cup mode shows the four ship cups (all disabled) plus a dev-only **Dev Cup** that hosts every playtest track (lagoon, cliffside, every GLB) — keeps the real race lineup uncluttered. Full Settings overlay (Audio / Video / Controls / Gameplay) with the entire v1 tunable inventory present and gated; the **Wave-pump prompt**, **AI difficulty**, **Rubber-band assist**, **Anti-grav camera intensity**, **Subtitles for tutorial**, **Replay tutorial**, **Master**, **Music**, **SFX**, **Ambient**, **Music bed enabled**, **Rebind keyboard**, **Rebind gamepad**, **Gamepad sensitivity**, **Deadzone**, and **Invert camera Y** rows are live. The **Tutorial** mode tile is also enabled. Reserved hidden HUD slots for wave-pump, anti-grav, tutorial, wave-line, cup-points, 8-bike positions. Single `.bc-disabled` + `.bc-gate` convention reused everywhere. See [docs/v1-work-breakdown.md](./v1-work-breakdown.md).
- **Foundation Systems milestone (5/5).** Step 1 of the v1 work-breakdown is done. Five systems each landed with sim behavior + settings entry + HUD/menu surface per the definition-of-done convention: wave-pump signal, AI difficulty, anti-grav HUD + camera, tutorial framework, audio mixer + music bed. Details below.
- **Wave-pump signal.** Render-side detector watches the player bike each frame; fires on a clean crest launch (on-water-grounded → airborne with vy ≥ 1.5 m/s, forward speed ≥ 45% of top speed, throttle ≥ 0.4, 500 ms cooldown). Strength-scaled HUD widget pops a chyron-style "PUMP +" flash with a cyan→yellow strength bar; audio engine plays a stacked perfect-5th chord (A4 + E5 + A5) under a band-passed whoosh sweep — distinct from `gateCleared`'s two-note ding so the player can tell pumps from checkpoints by ear. Settings → Gameplay → "Wave-pump prompt" toggles Full / Subtle / Off; persisted to localStorage. Sim-side pump physics tuning is still pending (M11–M12 proper); the detector's event contract holds — only the trigger heuristic gets upgraded.
- **AI difficulty + rubber-band toggle.** Three tiers (Casual / Standard / Hard) baked into each AI controller at spawn time via a tuning bundle (`src/game/ai/difficulty.ts`) — top-speed factor, lateral-accel ceiling, curvature lookahead, rubber-band bounds. Rubber-band system (`src/game/systems/rubber-band.ts`) reads the live `playerSettings.rubberBandAssist` toggle each tick so flipping mid-race settles AI back to its baseline rather than snapping. Settings → Gameplay → AI difficulty (select) + Rubber-band assist (toggle) wired and persisted.
- **Anti-grav surface — HUD + camera.** The anti-grav physics + Blender authoring shipped earlier; this is the player-facing layer. Magenta-glow HUD indicator binds to `#hud-anti-grav` and fades in with `AntiGravOverride.weight` crossing the same 0.05 threshold the resolver uses for its active flag. Chase camera's new `setAntiGravFollow(weight)` blends between yaw-only (default, motion-sickness-safe) and full bike-frame follow (rolls + pitches with the bike — loops actually invert the view), lerping on the same 0.15s tau as the gravity blend so the camera frame neither leads nor lags. Settings → Gameplay → "Anti-grav camera intensity" (Full / Reduced / Off) scales the camera follow weight — HUD intentionally stays on at "off" (the affordance signal is gameplay-critical; only the roll is the motion-sickness knob). `chase.snap()` catches up follow weight so respawns don't slide into the follow.
- **Tutorial framework (track-agnostic).** Director (`src/engine/tutorial/`) drives a script of beats — each beat pairs a player-facing prompt (mechanic name + one-line hint) with a `clearWhen` predicate evaluated against per-frame sample (player speed, throttle, pump events, orbit touch, anti-grav engagement). Default 6-beat script (THROTTLE → CRUISE → LOOK AROUND → WAVE PUMP → ANTI-GRAV → READY) clears on generic signals so it runs on any track without Sandbar dependencies. Top-centered yellow HUD chyron on `#hud-tutorial` flashes green on clears, settles to green "GOOD RIDE — GO RACE" on completion with a ~2.5s fade. URL param `?tutorial=1` activates it; both the menu's Tutorial mode tile and Settings → "Replay tutorial" button route through `buildReplayTutorialHref`. Subtitles toggle (Settings → Gameplay) hides the hint line; the title chyron + clear flash stay. First clean completion latches `tutorialCompleted=true` so the buttons re-label to "REPLAY". Strictly deterministic given the same per-frame sample sequence — replay-safety preserved.
- **Audio mixer + procedural music bed.** Four-bus rewrite of `AudioEngine`: `sources → music | sfx | ambient → master → destination`. Each bus is a GainNode driven by `playerSettings.audio<Bus>Volume × BUS_HEADROOM[bus]` (master 0.6, music 0.45, sfx 1.0, ambient 0.6 — slider=1.0 maps to a comfortable ceiling). Existing one-shots route to SFX (pickups, weapons, explosion, gate/lap dings, wave-pump chime, engine + wind), water rumble to Ambient. Music bus gets a new procedural pad bed — three-voice sine drone (A2/E3/A3) with tremolo LFO; intentionally bland, stand-in for the licensed/commissioned drop later in M11–12. New `duckMusic(amount, recoverSeconds)` sidechain helper auto-fires on wave-pump (0.35 + 0.3 × strength dip) and explosion (0.7 dip) so cues cut through. Settings → Audio → all four sliders + a "Music bed enabled" toggle wired through a new `audio-service` singleton (`src/engine/audio/audio-service.ts`) so the overlay can reach the live engine without prop-drilling from `main.ts`.
- Tracks on the level-select carousel: **Lagoon Loop** (default; jump ramp on the right straight), **Cliffside** (mesa with cliff drop, doubles as the Blender-export reference layout), **Calibration** (smoke-test fixture), **Test Ring** (collision tunneling regression), and two new procedural-island showcases — **Oval Loop** and **Figure Eight** — authored end-to-end in Blender using the addon's road / ramp / spline tools on a fresh HV_Island terrain. The two new tracks are the canonical proof that the Blender authoring stack (road slab + F1 curbs + ramp + snap + JSON sync + manifest upsert) can produce shippable courses without leaving Blender.
- Three bike archetypes — **Cruiser** (heavy / fast top speed), **Racer** (default balanced), **Stunt** (light / agile) — selectable via the garage menu or `?bike=`
- Garage menu (HUD button top-right) for picking bike + track + viewing / clearing best lap records
- Best lap times saved per (track, bike) to localStorage, surfaced in the finish overlay and garage menu
- Jump ramp on Lagoon's right straight (z = 25–37) — exercises raycast-vs-static-collider, surface alignment on a sloped normal, hover-spring release on launch, and water re-acquisition on landing
- Airborne control (M9.18) — bike floats through arcs (60% gravity counter while in the air, effective ~10 m/s² fall rate) instead of dropping like a rock; throttle while airborne pushes along the bike's forward direction so pitch-up extends air time and pitch-down dives
- Player spawns on the racing line at the start gate, facing forward
- Hover-bike physics (Rapier WASM, deterministic build)
- Gerstner wave water with buoyancy — bike rides waves, dives into troughs, launches off crests
- Faceted water surface + horizon-fading sky dome
- 4 AI racers with per-bike race-line offsets so they hold parallel lines (no convergence pile-up)
- Pickup boxes around the loop — full pool: boost, shield, mine, homing missile
- Boost pads — author-placed oriented rectangles (`+Boost` in `?edit=1`, `BoostPad` in the track JSON) refresh the bike's `BoostEffect` while overlapping. Strength multiplier = pad.strength; never weakens a stronger active boost. Implemented in `src/game/systems/boost-pad.ts`
- Race lap counting with finish overlay
- Direction arrow (Crazy Taxi style) above the player pointing to the next checkpoint
- Sky beacon over the next gate
- Auto-play mode (T or F1) — AI takes over the player bike for testing
- Backspace = respawn at start
- Mouse right-drag and gamepad right-stick orbit the camera (vertical inverted by default)
- 27 e2e + 67 unit tests, all green
- **Multiplayer lobby (M10.12)** — joining `?room=<id>` opens a lobby overlay listing every connected peer + their ready state. Click the "CLICK WHEN READY" button or press Enter to toggle your own ready. The race countdown is gated until everyone present has ready'd (minimum 1, so solo works). The lobby is end-to-end via the relay's JSON control channel: clients send `{type:'ready', ready: bool}`, server stamps the originating slot and re-broadcasts; clients also send `{type:'start-race'}` once their local view sees all-ready, server sets a sticky `raceStarted` bit that's replayed in subsequent `HelloMessage`s so late joiners skip the lobby. Sticky bit resets when the room empties.
- **Network telemetry — RTT + live connection state (2026-05-18).** Stateless `ping`/`pong` control messages echoed by the relay (no presence touched, doesn't move the sticky race-started bit). NetRoom runs a 1 Hz ping loop from `hello` onward, EWMA-smooths the RTT, and stale-resets to `—` after 6 s of pong silence. New `mp-status` pub/sub (`src/engine/net/mp-status.ts`) lets three surfaces share one source of truth: the Settings → Network tab (Region · Endpoint · Connection · Room · Latency), the lobby header (live `PING NN MS` badge alongside the room code), and the in-race `#hud-room` chip (`room: <id> | you: P<n>[host] | + P<m>... | NNms`). Reconnecting state is distinguished from initial connecting in both the HUD chip and the mp-status state machine. Closes the Multiplayer row in [docs/v1-work-breakdown.md](./v1-work-breakdown.md) (all three convention columns now ✅). See [src/engine/net/latency.ts](../src/engine/net/latency.ts), [src/engine/net/mp-status.ts](../src/engine/net/mp-status.ts).
- **Multiplayer state sync (M10.4–M10.11)** — opt-in via `?room=<id>` URL param. Local dev needs `pnpm party:dev` (PartyKit relay on :1999) alongside `pnpm dev` (Vite on :5191). The stateless relay (`party/relay.ts`) assigns peer slots 0..7 and broadcasts two binary message types distinguished by a 1-byte tag at offset 0: `InputFrame` (0x01, 11 B, 60 Hz) carries each peer's controls; `TransformSnapshot` (0x02, 8 + 24×N B, 20 Hz) carries owner-authoritative bike poses. The lowest-slot peer is the AI host: it alone runs `aiControlSystem` and broadcasts the 4 AI bike poses. Every peer also broadcasts its own player bike. Receivers' AI bikes and remote-peer bikes are kinematic-position rigid bodies whose pose is set from inbound snapshots, replacing the input-replay path which couldn't converge (each tab simulated AI independently). Local human's bike stays Dynamic + PeerControlled and is driven by its own input. Host changeover (e.g. peer 0 leaves) re-tags AI bikes via `applyHostRole` between fixed steps; new host re-derives `AIController` closest-point cache via `defaultAIController('main')`. `#hud-room` chip shows `[host]` when this peer owns AI. `__hover.net` probe surfaces `peerId()`, `remotePeers()`, `isHost()`, `recentRemoteFrames()`, `latestPeerIntents()`, `snapshotsReceived()`; `__hover.bikes()` now includes per-bike `bodyType`, `hasAI`, `peerControlled` for cross-tab diagnostics. **Not yet implemented**: render-side smoothing of the 20 Hz snaps (M10.12), owner-authoritative combat (M10.13), snapshot interpolation/extrapolation (M10.14), host-authoritative race state (M10.15), variant negotiation per peer, anti-cheat.
- Spec → GLB asset pipeline (M9.27, flipped to per-variant in M9.39): `specs/{bikes,props,tracks}/*.json` + `tools/blender/build_*.py` produce `public/assets/<cat>/*.glb` and `public/assets/manifest.json` via `pnpm gen:all`. Bike-loader instantiates the player + AI bike GLBs at boot; prop-loader pre-fetches asset-prop GLBs referenced by track JSON. **Bikes:** one `bikes-src/<id>.blend` per variant — open it in Blender, edit the variant directly (no shared kit, no propagation), click *Hoverbike → Export Bike to Game*, the GLB updates and the runtime picks it up on next reload. The same addon serves tracks via *Export Track to Game* and switches mode based on the .blend's parent dir. Headless `pnpm gen:bikes` opens each .blend, overlays spec.appearance recolour + spec.physics extras, exports. **Tracks:** spec-driven `build_track.py` round-trips through `tracks-src/<id>.blend` and emits both the GLB and a starter gameplay JSON. **Bike viewer** (`?viewer=<bikeId>` or the addon's *Copy Viewer URL*) opens a turntable with OrbitControls, sockets/colliders surfaced as gizmos.
- Vercel push-to-deploy, Cloudflare CDN ready (not yet attached to a domain)

### Multiplayer convention row closed (2026-05-18)

Closes the **Multiplayer** row in
[docs/v1-work-breakdown.md](./v1-work-breakdown.md) — all three columns
of the convention table (Functional / Settings entry / UI gate cleared)
now check ✅. The functional + UI columns were de-facto done at M10.12
when the lobby shipped; this work adds the missing settings surface
(network region + latency display) and the three player-facing
readouts that surface live connection telemetry, plus polish around
how the connecting / reconnecting / connected states read in the
existing chips.

New / changed modules:

- [src/engine/net/protocol.ts](../src/engine/net/protocol.ts) — adds
  `PingMessage` (client→server) and `PongMessage` (server→client) to
  the JSON control channel. `t` is opaque to the server — it just
  echoes the same value back so the client computes RTT against its
  own clock.
- [party/relay.ts](../party/relay.ts) — four-line ping branch in
  `onMessage` that sends a `PongMessage` to the originating connection
  only (no broadcast, no presence churn, doesn't move the sticky
  `raceStarted` bit). The parser accepts a `ping` only when `t` is a
  finite number, so a malformed payload drops silently rather than
  echoing garbage.
- [src/engine/net/latency.ts](../src/engine/net/latency.ts) — new pure
  module. `createLatencyTracker()` returns `{ record, current, reset,
  sampleCount }`. EWMA at α=0.25 (settles within ~10 samples while
  staying smooth tick-to-tick); first sample is taken as-is to skip
  the warm-up wobble. `current()` checks the most recent sample
  against a `LATENCY_STALE_MS=6000` window — three missed pongs and
  the readout falls back to -1 ("—" in the UI) rather than pinning to
  the last live value forever.
- [src/engine/net/mp-status.ts](../src/engine/net/mp-status.ts) — new
  one-publisher / many-subscriber view of the live MP state, consumed
  by Settings → Network, the lobby header, and the HUD chip. `MpStatus`
  is `{state, roomId, host, peerId, remoteCount, latencyMs, isHost}`;
  `setMpStatus(patch)` notifies subscribers iff at least one field
  actually changed (so a per-tick republish is safe — the snapshot
  pump calls it freely on every pong + every peer event).
- [src/engine/net/room.ts](../src/engine/net/room.ts) — `createNetRoom`
  now:
  - kicks off a 1 Hz ping loop from `hello` onward, recording each
    `pong` round-trip into the latency tracker;
  - publishes `MpStatus` updates on every lifecycle transition
    (connecting → connected → reconnecting / closed) and on every
    pong (so consumers can read smoothed RTT directly out of the pub);
  - exposes `latencyMs` (smoothed, stale-aware) and `everConnected`
    (true once the socket reaches OPEN at least once — distinguishes
    "first connect" from partysocket's auto-reconnect after a drop).
- [src/engine/menus/settings-overlay.ts](../src/engine/menus/settings-overlay.ts)
  — new **NETWORK** tab. A new `'readout'` control kind backs five
  read-only rows (Region, Endpoint, Connection, Room, Latency); a
  per-row `paintNetworkReadouts` function repaints on every
  mp-status change while the tab is open, and the subscription tears
  down on tab switch / overlay close. Region maps `localhost:1999` →
  `DEV (LOCAL)` and everything else → `AUTO · CLOUDFLARE EDGE` (honest
  about PartyKit's edge-routing without inventing a region picker the
  protocol doesn't expose).
- [src/engine/menus/mp-lobby.ts](../src/engine/menus/mp-lobby.ts) +
  [src/engine/render/lobby-overlay.ts](../src/engine/render/lobby-overlay.ts)
  — lobby header gets a `PING NN MS` badge alongside the room code. A
  1 Hz `setInterval` re-renders the lobby (cheap; render path is
  innerHTML on a small slot grid) so the readout moves even when
  nothing else is happening; teardown on `finish()` clears it.
- [src/boot/multiplayer.ts](../src/boot/multiplayer.ts) — HUD chip's
  `renderRoomChip()` now subscribes to mp-status so latency + peer
  changes refresh without a per-frame poll. Connected chip reads
  `room: <id> | you: P<n>[host] | + P<m>... | NNms`; pre-connect chip
  reads `connecting…` for a first-time attempt vs `reconnecting…`
  for a re-establish (partysocket auto-retries on its own; the chip
  names the difference).
- [index.html](../index.html) — CSS rule for `.sm-readout` (cyan
  monospace pill matching the rest of the settings chrome).

Tests: 491/491 unit tests passing (19 new).

- [tests/unit/latency.test.ts](../tests/unit/latency.test.ts) (8) —
  pre-sample default, first-sample exactness, EWMA blend math, negative
  clamp, sustained-step convergence, stale-window boundary + refresh,
  reset semantics.
- [tests/unit/mp-status.test.ts](../tests/unit/mp-status.test.ts) (7)
  — initial idle state, patch + notify, no-op when unchanged,
  undefined-field ignore, unsubscribe, reset behaviour from non-idle
  and from idle (no spurious fire).
- [tests/unit/relay-ping.test.ts](../tests/unit/relay-ping.test.ts) (4)
  — pong echoes the same `t` to the sender only (no broadcast), ping
  doesn't move the sticky race-started bit, malformed `t` is dropped
  silently, unassigned-slot ping is ignored.

### Wave-line shimmer overlay (2026-05-18)

Closes the wave-mastery pillar's *predictive* half in
[docs/v1-work-breakdown.md](./v1-work-breakdown.md) — the new
**Wave-line shimmer** row checks ✅ across all three columns of the
convention table. Pairs with the already-shipped wave-pump signal: that
fires *after* a clean crest launch, this lights up the crest *before*
the player commits, closing the loop on "where is the next pump
opportunity".

New / changed modules:

- [src/engine/render/wave-line-scoring.ts](../src/engine/render/wave-line-scoring.ts)
  — pure math, no Three.js. `buildSampleFan(buffer, origin, fwdX, fwdZ,
  config)` fills a pre-allocated buffer with `samplesAlong × samplesAcross`
  XZ points in the player's forward fan (default 7×3, range 6–36 m,
  half-angle ~12.6° → ±25° total). Mutates in place so the per-frame
  call is allocation-free. `scorePumpability(vy, ceiling=6)` maps
  surface vertical-velocity to a 0..1 score, with the same `vy` ceiling
  the wave-pump detector uses so both signals saturate on the same
  swells. Degenerate inputs (zero heading, non-finite vy, zero/negative
  ceiling) collapse cleanly to 0 / origin coords rather than NaN-ing
  the render layer.
- [src/engine/render/wave-line-shimmer.ts](../src/engine/render/wave-line-shimmer.ts)
  — Three.js renderer. Builds a pool sized to the fan config, one
  shared `MeshBasicMaterial` (additive blending, depth-write off) +
  shared `PlaneGeometry`, and a procedural radial-gradient
  `DataTexture` that reads as a soft disc with a brighter ring at
  r≈0.7. Each tick: flatten the player's quaternion to a horizontal
  forward, lay the fan, sample `sampleSurface` per marker (the CPU
  field already used by buoyancy — pure read), hide any score below
  0.12 to keep flat water clean, scale + position the rest. Per-marker
  pulse phase is pre-seeded across the pool so the shimmer feels alive
  even on a static wave field. `currentMaxScore()` exposes the
  brightest reading this tick — drives the HUD pip's lock state.
  Render-only; never writes sim state, no replay/determinism
  obligations.
- [src/engine/render/wave-line-hud.ts](../src/engine/render/wave-line-hud.ts)
  — small DOM pip lit from the reserved `#hud-wave-line` slot. Shows a
  `WAVE LINE` chip with a pulsing cyan dot whenever the system is on
  (mode = full), hides during lulls and lights up only on a strong lock
  (score ≥ 0.55) when mode = subtle, stays hidden when mode = off.
  Pip turns yellow on lock; brightness buckets to 5 levels so the
  per-frame DOM churn stays minimal.
- [src/engine/player-settings.ts](../src/engine/player-settings.ts)
  grows `waveLineIntensity: 'full' | 'subtle' | 'off'` (default
  `full`), with `setWaveLineIntensity()` setter and tolerant load
  (unknown strings ignored, default retained).
- [src/engine/menus/settings-overlay.ts](../src/engine/menus/settings-overlay.ts)
  — new **Gameplay → "Wave-line guidance"** select row, slotted right
  after the wave-pump prompt row so the two wave-mastery surfaces sit
  together.
- [src/main.ts](../src/main.ts) — instantiates `createWaveLineShimmer()`
  once during scene setup, adds the group to the scene, forwards the
  handle to the game loop.
- [src/boot/game-loop.ts](../src/boot/game-loop.ts) — ticks the
  shimmer + HUD pip per frame alongside the direction arrow. Hides
  both while paused / finished so the chrome stays clean between
  races.
- [index.html](../index.html) — CSS for the `#hud-wave-line` pip
  (broadcast palette: cyan default → yellow on lock, soft glow scaled
  by `--wl-strength` 0..1, smooth opacity/transform fade-in keyed off
  `.wl-active`).

Tests: 430/430 unit tests passing (15 new in
[tests/unit/wave-line-scoring.test.ts](../tests/unit/wave-line-scoring.test.ts)
— score saturation/floor, default ceiling, non-finite tolerance, fan
slot count, fan within range + half-angle, allocation-free reuse,
arbitrary heading rotation, defensive normalize, degenerate-zero
heading, single-along edge case, persistence round-trip + unknown
intensity rejection).

### Controls tab — rebind + stick tunables (2026-05-18)

Closes the **Input / controls** row in the v1 work-breakdown convention
table (functional + settings entry + UI gate cleared, all three checks).
The Step 0 scaffolding shipped a Controls tab with five disabled rows;
this pass makes every one of them live.

New / changed modules:

- [src/engine/input/bindings.ts](../src/engine/input/bindings.ts)
  — single source of truth for the action set, default tables, and the
  swap-on-rebind semantics. Eight keyboard actions
  (`throttleForward / throttleBack / steerLeft / steerRight / pitchUp /
  pitchDown / fire / boost`) each carry a `{primary, secondary}` pair;
  defaults are the existing WASD + arrows + Q-dives/E-lifts + Space +
  Shift mapping. Two gamepad actions (`fire`, `boost`) carry a single
  button index — defaults RB / LB. `assignKeyboardPrimary(bindings,
  action, code)` swaps so the previous holder of `code` receives our
  old primary (so a careless rebind never strands an action); a
  same-action secondary collision is cleared. `assignGamepadBinding`
  is the same for the gamepad table. `parseKeyboardBindings` /
  `parseGamepadBindings` are tolerant — malformed entries drop back to
  defaults, missing actions stay default, persisted shapes from older
  builds are ignored cleanly.
- [src/engine/player-settings.ts](../src/engine/player-settings.ts)
  grows five fields: `keyboardBindings`, `gamepadBindings`,
  `gamepadSensitivity` (0.5–3.0, default 1.0), `gamepadDeadzone`
  (0–0.5, default 0.12), `invertCameraY` (boolean, default false).
  Setters + a per-table `reset…Bindings()`. The default record is
  frozen; the live `playerSettings` deep-clones the nested binding
  maps at module init so the rebind modal can mutate them in place
  without trampling the frozen defaults.
- [src/engine/dev-settings.ts](../src/engine/dev-settings.ts) +
  [src/engine/dev-settings-menu.ts](../src/engine/dev-settings-menu.ts)
  + [index.html](../index.html) lose the `gamepadDeadzone` slider and
  the `cameraInvertY` toggle — they moved to the Controls tab. The
  dev menu keeps low-level feel knobs only (camera mouse / stick range,
  stick curve, keyboard smoothing, steer-release tightness).
- [src/engine/input/keyboard.ts](../src/engine/input/keyboard.ts) now
  looks up action state through the live binding table:
  `throttle = throttleForward - throttleBack` etc. Brake fires
  whenever the `throttleBack` action is held (rebindable along with
  the rest). Smoothing rates remain on `devSettings`.
- [src/engine/input/gamepad.ts](../src/engine/input/gamepad.ts) reads
  `playerSettings.gamepadDeadzone` for the left-stick shape and
  multiplies the shaped magnitude by
  `playerSettings.gamepadSensitivity`, clamping the result to [-1, 1]
  so >1 saturates earlier rather than overshooting full deflection.
  Triggers (LT/RT) and stick axes stay on the W3C standard mapping;
  only the action buttons (fire / boost) are rebindable. Exposes
  `pollGamepadButtonPress()` for the rebind capture flow — returns
  the first non-trigger button that's currently pressed.
- [src/engine/input/camera-look.ts](../src/engine/input/camera-look.ts)
  reads `playerSettings.invertCameraY` directly (default false →
  ySign = -1 → matches the previous "push up / drag up = camera up"
  feel). Flipping the toggle gives flight-stick convention.
- [src/engine/menus/rebind-modal.ts](../src/engine/menus/rebind-modal.ts)
  + new `#rebind-menu` overlay in [index.html](../index.html) drive
  the capture flow. Mode-aware (`open('keyboard')` /
  `open('gamepad')`): each row shows the action label + a clickable
  primary chip; keyboard rows also surface a read-only secondary hint
  chip when a default secondary is present. Clicking a chip enters
  capture: keyboard captures the next `keydown` (Esc cancels);
  gamepad polls `pollGamepadButtonPress` on rAF and commits the first
  newly-pressed non-trigger button — `previousPressed` tracking
  guards against double-capture if a button was already down when the
  player clicked into capture. Bindings persist via
  `setKeyboardBindings` / `setGamepadBindings`. RESET-to-defaults +
  DONE buttons. Esc closes the modal; while capturing, Esc cancels
  capture instead. The modal sits at `z-index: 70` over the settings
  overlay (`z-index: 66`) and registers its keydown handler in
  capture phase so Esc doesn't fall through to settings.
- [src/engine/menus/settings-overlay.ts](../src/engine/menus/settings-overlay.ts)
  flips the five Controls rows to `enabled: true` and wires them:
  rebind buttons open the modal, sensitivity / deadzone sliders call
  `setGamepadSensitivity` / `setGamepadDeadzone` on `input`, and the
  invert-Y toggle calls `setInvertCameraY` on `change`. The row
  defaults read from live `playerSettings` so a reopen after a tweak
  shows the persisted value.

Why migrate the dev-settings knobs:

- Two surfaces editing the same value (Dev Settings → Stick deadzone
  + Settings → Controls → Deadzone) drift in playtest. Making
  `playerSettings.gamepadDeadzone` canonical and removing the
  duplicate keeps the menu inventory honest.
- The dev-settings menu still owns the *finer* feel knobs (stick
  curve, smoothing rates, camera ranges) — those don't belong in a
  player-facing surface.

What's deliberately NOT in this pass:

- **No rebind for analog axes / triggers.** Stick X = steer, stick Y
  = pitch, LT = brake, RT = throttle stay fixed on the W3C standard
  mapping. Players overwhelmingly tune those via sensitivity +
  deadzone, which the Controls tab does cover.
- **Gamepad navigation inside the rebind modal is mouse / keyboard
  only.** Opening the modal via mouse click then capturing a gamepad
  button still works (that's the point — the gamepad is what's
  being captured). Navigating the modal *with* a gamepad to pick a
  different row is a polish item.
- **Touch input doesn't read sensitivity.** Touch sticks have their
  own hardcoded deadzone + curve (status doc M9.40 notes); the
  Controls slider's gate label says "Gamepad sensitivity" for that
  reason.

Tests ([tests/unit/input-bindings.test.ts](../tests/unit/input-bindings.test.ts)):
29 new specs covering default tables (incl. the Q-dives/E-lifts
convention pin), `assignKeyboardPrimary` swap semantics (across
actions, within action, no-op for same code, secondary collision
clear, no input-mutation), `assignGamepadBinding` swap semantics,
lookup helpers, the tolerant parse functions (garbage / partial /
malformed payloads), label formatters, and `playerSettings`
round-trips through localStorage. 399/399 unit tests passing.

### Cup wiring via Dev Placeholder Cup (2026-05-18)

Second entry in **Step 6 — Modes** from
[docs/v1-work-breakdown.md](./v1-work-breakdown.md). The cup mode tile
was lit in Step 0 but routed to a one-off track picker; this pass
makes it a real championship by stringing 3 dev tracks into a 3-race
cup so all the wiring (per-race finish recording, points table,
post-race NEXT routing, end-of-cup summary) is exercised before any
of the four ship cups have their tracks.

New / changed modules:

- [src/engine/cup-progress.ts](../src/engine/cup-progress.ts)
  — sessionStorage-backed state for the in-flight cup: `cupId`,
  `bikeId`, `races: string[]`, `currentRaceIndex`, per-race results
  keyed by trackId, `startedAt` timestamp. MK8 / F1 point curve
  (`CUP_POINTS`, `pointsForPosition`) — 15/12/10/9/8/7/6/5/4/3/2/1.
  Retry-safe: `recordCupRaceFinish` matches by trackId so re-racing a
  slot overwrites it, and the pointer never un-skips (a retry of a
  past race doesn't lose your progress on later ones).
- [src/engine/menus/tracks-catalog.ts](../src/engine/menus/tracks-catalog.ts)
  — `CupEntry` gains `races: string[]`. The four ship cups are
  pre-wired via `shipCupRaces(id)` (filtered `V1_TRACKS` in catalogue
  order), so the moment any cup's tracks flip to `status: 'ship'`
  their championship runs without further wiring. New
  `DEV_PLACEHOLDER_CUP` (dev builds only) carries
  `['lagoon', 'cliffside', 'big-bay']` — two procedurals guaranteed
  to load plus one GLB so the cup chain exercises both loader paths.
- [src/engine/menus/menu-flow.ts](../src/engine/menus/menu-flow.ts)
  — cup-tracks screen splits behaviour by cup shape: browse Dev Cup
  keeps its tile-as-launcher behaviour, championship-shaped cups
  (placeholder + future ship cups) render inert preview tiles plus a
  single **START CUP** CTA. New `commitSpCup()` seeds cup-progress
  and stamps `?cup=<id>` on the race URL. TT mode (which also lands
  on this screen) is kept on the browse path via a `currentMode`
  guard so the championship CTA only appears for cup mode.
- [src/engine/render/cup-results-screen.ts](../src/engine/render/cup-results-screen.ts)
  + new `#cup-results` overlay in [index.html](../index.html) —
  championship summary shown over the finish screen after the last
  race. Per-race points table (race # / venue / finish / points)
  with a TOTAL row and a CHAMPION banner reading `YOU · X/MAX PTS`
  so the player sees their proximity to a clean sweep. ESC or Enter
  closes the overlay and routes through the same EXIT-clears-cup
  path as the finish screen.
- [src/boot/game-loop.ts](../src/boot/game-loop.ts) — `showFinishScreen`
  branches on the URL `?cup=` param. Mid-cup, NEXT becomes
  `NEXT RACE (n/m)` and carries the cup id forward; on the final race
  it becomes `CUP RESULTS →` and pops the overlay. A compact
  `CUP STANDING · n/m · X PTS THIS RACE · Y TOTAL` row is appended
  to the stat block on every cup race. RETRY in cup mode preserves
  progress (sessionStorage survives the reload, finish overwrites
  the slot). EXIT (finish + pause-menu) always clears cup-progress
  so the title screen doesn't surface stale state.
- [src/boot/controls.ts](../src/boot/controls.ts) — pause-menu
  RESTART threads `?cup=` through the retry URL so a mid-cup pause +
  restart stays in cup mode.

Why a placeholder rather than waiting for ship tracks:

- The wiring (points formula, post-race NEXT routing, finish-overlay
  branching, cup-results overlay, URL contract) is independent of
  which 3-4 tracks make up a cup. Building it against a placeholder
  means the ship cups light up automatically once their tracks are
  ready, with zero cup-mode work needed at sprint-1 / sprint-2 /
  sprint-3 boundaries.
- The placeholder also catches the awkward edge cases (retry-doesn't-
  un-skip, EXIT clears state, ESC out of cup-results) under playtest
  conditions instead of during the late-sprint crunch.

What's deliberately NOT in this pass:

- **No new settings row.** Cup mode reuses the existing AI difficulty
  + rubber-band assist toggles. The `where applicable` clause of the
  definition-of-done convention covers this; ship cups can revisit
  if a real per-cup tunable emerges.
- **Multiplayer cup mode is suppressed.** `?cup=` is ignored when
  `?room=` is set. Cup + multiplayer is a future-work bridge, not v1.
- **No "Resume cup" affordance on the title screen.** EXIT mid-cup
  drops state. Simple semantics; can revisit if playtest reveals a
  resume use-case.

Tests ([tests/unit/cup-progress.test.ts](../tests/unit/cup-progress.test.ts)):
6 new specs — point curve correctness, sessionStorage round-trip,
mismatched-cup-id rejection, retry-overwrites-without-un-skipping,
isCupComplete gate, totalCupPoints sum. 370/370 unit tests passing.

### Time Trial mode + ghost recording (2026-05-18)

First entry in **Step 6 — Modes** from
[docs/v1-work-breakdown.md](./v1-work-breakdown.md). Sits on top of the
existing replay infrastructure (pose recorder, SLERP playback,
`recordLapTime` storage) and wires four new modules together:

- [src/engine/replay/best-lap-slice.ts](../src/engine/replay/best-lap-slice.ts)
  — `sliceBestLap(replay)` walks the recorder's `lap` events,
  finds the player's fastest lap, slices the frame window in
  `[tLapStart, tLapEnd]`, and emits a single-bike, single-lap
  ReplayFile with timestamps rebased to t=0. `recordEvent` finally
  has a caller — `main.ts`'s `onCheckpoint` handler now stamps a
  `{kind:'lap', t, slot:0, lap, lapTime}` event on every closed lap.
- [src/engine/replay/ghost-state.ts](../src/engine/replay/ghost-state.ts)
  — localStorage persistence under `hoverbike.ghosts.v1` keyed by
  `${trackId}::${bikeId}`. `getGhost`, `setGhost`, `getGhostBestLap`,
  `clearGhosts`. Corrupt payloads are silently dropped on read.
- [src/game/systems/ghost-runner.ts](../src/game/systems/ghost-runner.ts)
  — drives the ghost entity's Transform each render frame off the
  *player's current lap time* (not wall clock), so the ghost stays a
  meaningful pacing reference: if the player's lap is 18 s and the
  ghost's recorded lap is 20 s, the ghost is roughly 10% behind on
  the racing line at all times. Detects lap reset (player's lapTime
  drops toward 0) and seeks the ghost back to t=0. Held at start
  pose pre-countdown via the `arm` flag.
- [src/game/components/index.ts](../src/game/components/index.ts) +
  [src/game/entities/bike.ts](../src/game/entities/bike.ts) —
  new `GhostTag` component; `createBike({ ghost: true })` mints a
  render-only entity with `BikeTag + Transform + BikeStats + GhostTag`
  and skips RigidBody / collider / rider / Racer / AI / Peer /
  PickupSlot wiring. Sim systems gate on those tags so the ghost
  participates in nothing.

Render-side, [src/engine/render/render-systems.ts](../src/engine/render/render-systems.ts)
detects `GhostTag` on first sight of a bike entity, clones the
variant mesh with cyan livery + exhaust tints, and walks the cloned
tree applying a translucent material (opacity 0.35, no depth write,
no shadow cast/receive, emissive cyan glow). The variant comes from
the player's chosen bike — so the ghost reads as "you (last run)"
not "some opponent."

Menu flow ([src/engine/menus/menu-flow.ts](../src/engine/menus/menu-flow.ts)):
the Time Trial tile flipped to enabled with the desc "Solo against
the clock with a saved best-lap ghost." TT mode reuses the
`sp-cup-tracks` step with Dev Cup auto-selected (devs play TT
against today's playable maps; ship-status v1 tracks light up here
naturally once they land). Commit emits `?race=1&track=…&bike=…&tt=1`.

Finish overlay ([src/boot/game-loop.ts](../src/boot/game-loop.ts)):
- title reads `TIME TRIAL`, ribbon `CLOCK`, position row blanks
  (TT is solo so "1st against no one" would be a lie),
- recorder finalizes as usual; `sliceBestLap(replay)` runs and
  `setGhost` persists when the new best lap beats the stored ghost's
  best lap (or there's none),
- best-lap row gets a `★ GHOST SAVED` pill on every PB,
- RETRY is the default focus (and carries `tt=1` forward); NEXT is
  hidden — the TT loop is "grind the same track."

Tests ([tests/unit/](../tests/unit/)): 354/354 passing (19 new):
- `ghost-state.test.ts` — set/get round-trip, overwrite, per-(track,
  bike) isolation, corrupt-payload recovery, clearGhosts.
- `best-lap-slice.test.ts` — fastest-of-three extraction, multi-bike
  slot stripping, negative-tStart rejection, frame-count guard,
  cross-slot event filtering.
- `ghost-runner.test.ts` — start-pose plant, lap-time-driven Transform
  writes, lap reset on player crossing, pre-countdown hold, reset(),
  end-pose freeze when ghost finishes first.

Browser smoke-tested via Claude Preview: TT tile enabled, mode →
track → bike flow lands on `?race=1&track=lagoon&bike=racer&tt=1`,
sim spins up with 1 dynamic bike (no AI). Ghost spawn path verified
at the unit level (the ghost entity has no RigidBody so the existing
`__hover.bikes()` debug probe — which iterates `BikeTag + RBHandle`
— filters it out).

### v1 cathedral + wave-pump signal (2026-05-17)

First two checkpoints of [docs/v1-work-breakdown.md](./v1-work-breakdown.md):
**Step 0 — Scaffolding** ([#110](https://github.com/occ-matt/hoverbike/pull/110))
and **Step 1 — Wave-pump signal**
([#111](https://github.com/occ-matt/hoverbike/pull/111)).

**Menu cathedral.** Cold-boot flow is now the full v1 shape with most
surfaces disabled. New files:
- [src/engine/menus/tracks-catalog.ts](../src/engine/menus/tracks-catalog.ts)
  — pure data for the 12 v1 tracks (post-flood landmarks, set-pieces,
  cup assignment, lap targets, gate labels), the 4 ship cups, and the
  Dev Cup.
- [src/engine/menus/settings-overlay.ts](../src/engine/menus/settings-overlay.ts)
  — lazy-imported overlay with Audio / Video / Controls / Gameplay tabs;
  every v1 tunable row present, each disabled row carrying a gate label
  pointing at the milestone that lights it up.
- [src/engine/menus/menu-flow.ts](../src/engine/menus/menu-flow.ts)
  extended with 5-mode select (Race / Time Trial / Cup / Multiplayer /
  Tutorial — Race + Cup + Multiplayer enabled, the other two gated),
  cup-select screen, cup-track list, tutorial-intro stub, leaderboard
  stub. Bike-select now renders 3 active + 2 "Coming soon" slots.

The disabled-state convention is a single `.bc-disabled` class with a
`.bc-gate` block — locked once, reused everywhere. Gamepad nav skips
disabled tiles automatically. HUD scaffolding slots
(`#hud-wave-pump`, `#hud-anti-grav`, `#hud-wave-line`,
`#hud-cup-points`, `#hud-positions`) are reserved hidden DOM that each
owning system flips visible when its definition-of-done lands.

**Dev Cup is the playtest path.** The four real race cups (Reef / Open
Sea / Continental / Drowned) all render disabled in Step 0 — none of
their tracks have shipped. The Dev Cup tile renders only in
`import.meta.env.DEV` builds, and lists the procedural Lagoon Loop +
Cliffside plus every GLB the asset manifest knows about (14 playable
tracks today). Today's devs reach a race via Cup → Dev Cup → track →
bike; the four real cups stay clean as their tracks land sprint by
sprint.

**Wave-pump signal.** First Foundation Systems milestone — lights up
its HUD slot, its settings row, and its sim trigger all at once. New
files:
- [src/engine/wave-pump-observer.ts](../src/engine/wave-pump-observer.ts)
  — render-side detector. Heuristic: bike was on-water-grounded last
  tick, this tick is airborne with vy ≥ 1.5 m/s, forward speed ≥ 45%
  of top speed, throttle ≥ 0.4. 500 ms cooldown so chained wavelet hops
  don't double-fire. Strength score (0..1) blends vy excess with speed
  fraction; HUD + audio scale to it.
- [src/engine/render/wave-pump-hud.ts](../src/engine/render/wave-pump-hud.ts)
  — binds to `#hud-wave-pump`. `full` mode renders the chyron-style
  flash with the cyan→yellow strength bar; `subtle` mode renders a
  small cyan pulse dot; `off` renders nothing. CSS `--wp-strength` var
  drives glow + bar fill.
- [src/engine/player-settings.ts](../src/engine/player-settings.ts) —
  separate from input-feel `dev-settings`, persisted to localStorage
  under `hoverbike.playerSettings.v1`. Loaded on boot in `main.ts`.
- [src/engine/audio/audio.ts](../src/engine/audio/audio.ts) gained a
  `wavePump(strength)` method — stacked perfect-5th chord (A4 + E5 +
  A5) over a band-passed whoosh sweep. Distinct from `gateCleared`'s
  two-note ding so pumps + checkpoints are audibly different.
- 11 deterministic detector tests in
  [tests/unit/wave-pump-observer.test.ts](../tests/unit/wave-pump-observer.test.ts)
  cover the happy path + every gate (vy floor, speed floor, throttle
  floor, surface-is-water requirement, cooldown, reset).

The detector lives on the render side (not in `simulateStep`) because
pump events are pure UI/audio feedback — no determinism dependency, no
replay obligation. When the proper sim-side pump physics tuning lands
in M11–M12, only the trigger heuristic changes; the
`wavePumpHud.pump(strength)` + `audio.wavePump(strength)` contract
stays.

### Foundation Systems complete (2026-05-18)

[PR #113](https://github.com/occ-matt/hoverbike/pull/113). Four
foundation systems landed on top of Step 0 + wave-pump, closing the
**Step 1 — Foundation systems** row in
[docs/v1-work-breakdown.md](./v1-work-breakdown.md) at 5/5. Each
system follows the same definition-of-done: sim/behavior + settings
entry + HUD/menu surface, all three checkboxes flipped at once.

**AI difficulty + rubber-band toggle.** Three-tier per-AI tuning
bundle baked into the controller at spawn time:
- [src/game/ai/difficulty.ts](../src/game/ai/difficulty.ts) — Casual /
  Standard / Hard each set top-speed factor, lateral-accel ceiling,
  curvature lookahead, and rubber-band catch-up bounds. Bundle is
  resolved from `playerSettings.aiDifficulty` at AI spawn so a change
  takes effect on the next race.
- [src/game/systems/rubber-band.ts](../src/game/systems/rubber-band.ts)
  gates on `playerSettings.rubberBandAssist` each tick — flipping the
  toggle mid-race settles AI back to its baseline instead of
  snapping. When off, the system is a no-op.
- Settings → Gameplay → AI difficulty (select) and Rubber-band
  assist (toggle) wired + persisted.

**Anti-grav surface — HUD + camera intensity.**
- [src/engine/render/anti-grav-hud.ts](../src/engine/render/anti-grav-hud.ts)
  — binds to the reserved `#hud-anti-grav` slot. Magenta-glow shell +
  pulsing ring + "ANTI-GRAV ON" chyron, `--ag-weight` CSS var drives
  border-glow / ring brightness. Crosses the same 0.05 active
  threshold `antiGravSystem` uses so HUD and gravity-scale flip in
  lockstep.
- [src/engine/render/camera.ts](../src/engine/render/camera.ts) grew
  `setAntiGravFollow(weight)` — weight=0 keeps the yaw-only steady-
  state frame, weight=1 rotates offset + look-ahead by the full bike
  quaternion so banked walls + 360° loops roll the view. Lerps on
  the same `FOLLOW_SMOOTH_TAU = 0.15s` as the AntiGravOverride
  up-vector smoothing → no lead/lag. `snap()` catches up the follow
  weight so respawn mid-anti-grav doesn't slide into the follow over
  ~150ms.
- Settings → Gameplay → "Anti-grav camera intensity" (Full / Reduced
  / Off) scales `AntiGravOverride.weight × scalar` upstream. HUD is
  intentionally always-on (the affordance signal is gameplay-
  critical); only the camera follow opts out at "off" — the motion-
  sickness knob.

**Tutorial framework (track-agnostic).** New
[src/engine/tutorial/](../src/engine/tutorial/) directory:
- `tutorial-script.ts` — types for a `TutorialScript` of
  `TutorialBeat`s. Each beat pairs a player-facing prompt (mechanic
  name + one-line hint) with a `clearWhen` predicate evaluated
  against a read-only per-frame `TutorialContext` (player speed,
  throttle, pump events, orbit touch, anti-grav engagement), plus an
  optional `clearAfterSeconds` timeout for passive beats.
- `DEFAULT_TUTORIAL_SCRIPT` — 6 beats: THROTTLE → CRUISE → LOOK
  AROUND → WAVE PUMP → ANTI-GRAV → READY. Clears on generic
  signals so it runs on any track without Sandbar dependencies.
- `tutorial-director.ts` — pure-logic advancer. Holds the active
  beat index, accumulates per-beat counters, evaluates clearWhen +
  timeouts, fires `onBeatArmed` / `onBeatCleared` / `onCompleted`
  lifecycle callbacks. Strictly deterministic given the same sample
  sequence so replay-safety isn't sacrificed.
- `tutorial-launch.ts` — shared URL builder used by the Settings
  "Replay tutorial" button and the menu mode-tile.
- [src/engine/render/tutorial-hud.ts](../src/engine/render/tutorial-hud.ts)
  — top-centered yellow chyron on `#hud-tutorial`. Flashes green on
  beat clear, settles to green "GOOD RIDE — GO RACE" on completion
  with a ~2.5s fade. Subtitles toggle hides the hint line; the title
  chyron + clear flash stay (chyron is gameplay-critical, hint is
  the read-along layer).
- URL param `?tutorial=1` activates the director in `startGameLoop`;
  the menu's Tutorial mode tile flipped to enabled, and Settings →
  Gameplay → "Replay tutorial" button + "Subtitles for tutorial"
  toggle wired + persisted. First clean completion latches
  `tutorialCompleted=true` so the buttons re-label to "REPLAY".

**Audio mixer + procedural music bed.**
- [src/engine/audio/audio.ts](../src/engine/audio/audio.ts) rewritten
  to four buses: `sources → music | sfx | ambient → master →
  destination`. Each bus a GainNode driven by
  `playerSettings.audio<Bus>Volume × BUS_HEADROOM[bus]`. Per-bus
  headroom keeps slider=1.0 at a comfortable ceiling instead of 0dB
  clipping.
- Existing one-shots routed to SFX (pickups, weapons, explosion,
  gate/lap dings, wave-pump chime + whoosh, engine + wind). Looping
  water rumble routed to Ambient. Music bus gets the new procedural
  pad bed — three-voice sine drone (A2 / E3 / A3) with a slow
  tremolo LFO. Intentionally bland; stand-in for the licensed/
  commissioned drop later in M11–12. `setMusicEnabled(false)` dials
  it to 0 without unwiring so the swap-in is a one-liner.
- New `duckMusic(amount, recoverSeconds)` sidechain helper auto-
  fires on wave-pump (0.35 + 0.3 × strength dip, 0.45s recover) and
  explosion (0.7 dip, 0.6s recover). Standard sidechain shape: 40ms
  attack, linear recover.
- [src/engine/audio/audio-service.ts](../src/engine/audio/audio-service.ts)
  — singleton registry so Settings overlay can reach the live engine
  without prop-drilling from `main.ts`.
  `applyAudioBusVolume` / `applyAudioMusicEnabled` helpers no-op
  when no engine is registered (the main-menu can open Settings
  before audio context is up).
- Settings → Audio rows for all four sliders + a "Music bed
  enabled" toggle wired and persisted via
  `setAudioBusVolume(bus, volume)` + `setAudioMusicEnabled(on)`,
  which clamp, persist, AND re-apply to the live engine in one
  call.

**Tests.** 335/335 unit tests passing — 26 new across the session:
- 6 in [tests/unit/anti-grav-camera.test.ts](../tests/unit/anti-grav-camera.test.ts)
  cover the camera scalar table, localStorage round-trip, and chase-
  camera follow blends at weight=0 / 0.5 / 1 + the snap() catch-up.
- 9 in [tests/unit/tutorial-director.test.ts](../tests/unit/tutorial-director.test.ts)
  cover lifecycle, predicate clears, timeout fallback, completion
  semantics, per-beat counters resetting at arm, orbit/pump signals,
  manual skip, ctx time accuracy.
- 4 in [tests/unit/tutorial-launch.test.ts](../tests/unit/tutorial-launch.test.ts)
  cover the URL round-trip, lagoon fallback, bike-omitted edge case,
  and clean-tutorial-route param dropping.
- 7 in [tests/unit/audio-mixer.test.ts](../tests/unit/audio-mixer.test.ts)
  cover per-bus field writes, [0,1] clamping, localStorage round-
  trip, NaN/Infinity rejection, and the audio-service registry +
  null-engine fallback.

The Web Audio path itself is smoke-tested in the browser — jsdom
doesn't ship Web Audio so the AudioEngine creation stays out of the
unit-test layer.

### Authoring — addon UX rework + water decoupling + island spawn (2026-05-19)
- **Top-bar Hoverbike menu.** New View3D-header dropdown (next to
  View / Select / Add / Object — BlenderGIS-style) holding every
  operator categorised under Add / Build-Refresh / Spline / Terrain
  / Thumbnail / Utility. Always available regardless of selection,
  so finding a tool no longer requires scrolling the N-panel. A
  *Quick Pie* menu on Shift+W in the 3D view covers the eight
  most-used actions for the in-viewport authoring loop.
- **Selection-driven N-panel.** Twelve per-tool sub-panels (spline,
  road, tunnels, anti-grav, ramps, downtown, terrain, water,
  horizon, waves, gameplay, placement helper) now appear only when
  their target object is the active selection. Scene-wide sub-panels
  (Sky, Shader, Stats, Hero, Ghost, Emitters) stay always-on but
  default-closed. The N-panel header shows an *Active: …* hint plus
  pointers to the top-bar menu and pie shortcut, so the new model
  is self-documenting.
- **Sea level decoupled from `water_volume_main`.** The scene prop
  `hoverbike_water_height` is now the canonical sea level — the
  slider writes it directly, the export reads it, the JSON-reload
  writes it back, and the wave-preview mesh's Z follows it.
  `water_volume_main` becomes optional: only useful for
  `wave_height` / `wave_freq` custom-prop overrides per track. Old
  .blends migrate lazily — first read after open promotes a legacy
  volume's Z into the scene prop, so existing tracks export the same
  height as before.
- **Add Island Terrain operator.** New entry under Hoverbike → Add
  → *Terrain templates* (and Terrain submenu) that spawns a
  1024×1024 m subdivided plane with the `HV_Island` Geometry-Nodes
  modifier + four default peak control empties into the current
  scene — same procedural setup `template-island.blend` ships with,
  but layered onto existing work rather than requiring a fresh
  template-copy. Loads `seed_template_island.py` lazily by file
  path; idempotent on reuse (refuses on existing `terrain`; reuses
  `HV_TemplateIsland` / `HV_PeakProfile` node groups; skips
  already-spawned peak empties).
- **Stable preview-collection state.** Gate, water, and racer
  preview rebuilds now reuse the existing collection instead of
  nuke-and-recreate, so the Outliner's collapse state survives
  debounced spline / slider edits. Wave-zone child gizmos render
  as wireframe instead of solid translucent — overlapping zones
  read cleanly. The install-addon script also picks up
  dangling-symlink repair so deleted-worktree recoveries no longer
  EEXIST.

### Authoring — tunnels, downtown, placement helper, terrain coloration (2026-05-15)
- **Tunnel tool.** Bezier curve through a hill → *Build Tunnel* emits a
  cylindrical cutter (hidden in `_hoverbike_tunnel_cutters`) plus an
  inward-facing concrete-liner shell (`tunnel_NN_interior`,
  `kind=track`). Terrain carries a single Boolean DIFFERENCE
  modifier (`HV_Tunnel_Cut`) targeting the cutters *collection*, so
  additional tunnels just drop another cutter in. `export_apply=True`
  on the glTF exporter bakes the cut into the GLB — game side gets
  carved-terrain geometry with zero new code. Reference scene:
  `tracks-src/template-tunnel-island.blend` (mountainous island, three
  tunnels, AI-completable circuit). Verified end-to-end: in-game AI
  racer completes a full lap through all three tunnels.
- **Downtown generator.** Parented `downtown_NN` city-block grid
  (placeholder boxy mid-rise + plinth, deterministic seed). Each
  building's footprint corners are raycast onto the largest visible
  `kind=track` mesh; base seats at the highest corner with a
  downhill-skirt extension that buries the low side in the slope —
  SF "buildings step into the hill" look, no floating stilts. Plinth
  is a block-aligned subdivision grid with two material slots
  (sidewalk concrete + asphalt road), per-face indexed so streets
  read as a darker grid against lighter sidewalks (single mesh, no
  z-fight). Reference scene: `tracks-src/template-downtown.blend`
  (Miami-flat valley + Nob-Hill 56 m grade + Telegraph-Ridge 78 m
  grade, with up to 31 m building skirts on the steep side).
- **Placement helper.** Singleton curve-constrained empty driven by
  *t* + lateral offset sliders. Live re-poses on slider scrub *and*
  on curve edits via the existing debounce timer. One-click
  *Cursor → Helper* / *Add Ramp at Helper* / *Add Boost at Helper*
  drops items at the helper's pose without having to snap the
  cursor manually first.
- **SOTA terrain coloration pass.** Runtime `mat_terrain_runtime`
  shader gets domain-warped noise UVs, triplanar cliff sampling,
  three-way slope split (flat → scree → cliff), stochastic altitude
  jitter (kills perfectly level contour lines), and HSV-style
  saturation tied to a low-freq macro biome noise. Seven new
  `TerrainShaderConfig` fields plumbed end-to-end (Blender panel →
  JSON → runtime), all no-op at default so existing tracks keep
  their stock look until re-exported.
- **Two latent bugs fixed during verification.** (1) Runtime terrain-
  shader detection in `applyTerrainShaderToScene` was matching on
  `kind === 'track'`, which over-broadly grabbed every collidable
  mesh (downtown buildings, ramps, tunnel interiors, road slabs) and
  replaced their authored materials with the slope/altitude ramp.
  Narrowed to "name starts with `terrain` OR a material is
  `mat_terrain_main`". (2) `derive_track_json` hardcoded the
  exported checkpoint quaternion as identity, so every template-
  authored gate faced three.js +Z (= south) and the AI couldn't
  cross any east/west-running gate. Now reads `rotation_euler.z` and
  emits the corresponding Y-axis quaternion.

### Authoring — Blender road / ramp / track tools (2026-05-13)
- **Road tool.** Bezier curve → drivable road slab tagged `kind=track`
  with `mat_track_road` asphalt + optional F1-style red/white curbs
  (`mat_track_curb_red`, `mat_track_curb_white`). Scene props for width,
  lift, slab thickness, curb width/height, stripe length, samples,
  smoothing. Terrain is conformed to the road's altitude in a
  `width/2 + curb_width + blend_radius` band with a smoothstep falloff
  and an upper cap clamping each vertex below the drivable surface so
  steep slopes can't poke through. Errors out on active terrain
  modifiers by default; opt-in `apply_modifiers=True` toggle bakes the
  GN graph into the source mesh before deforming.
- **Ramp tool.** Parametric stunt-ramp wedge at the 3D cursor — length /
  width / peak / approach / segments / curved (smoothstep). 30 cm
  foundation depth so the wedge is always a closed solid; tagged
  `kind=track` with `mat_track_ramp`. Each ramp gets a fresh `ramp_NN`
  name so repeated placement doesn't stomp.
- **Snap Spline to Terrain.** Raycasts every NURBS / Bezier control
  point of `ai_spline_main` straight down onto the scene and lifts by
  the configured hover height. The depsgraph is refreshed inside the
  preview-hidden context so gate / racer / water gizmos can't catch
  the ray.
- **Heightmap importer.** Greyscale PNG/EXR → subdivided plane tagged
  `kind=track`. Size, Δz, base elevation, subdivisions are scene props;
  re-import replaces any prior `terrain_heightmap` cleanly.
- **Ghost lap + chase cam.** Bike silhouette bound to `ai_spline_main`
  via a Follow Path constraint, parented chase camera with Track-To,
  scene frame range set to one full lap at target speed. Spacebar plays
  the lap; chase cam is the scene's active camera.
- **JSON ↔ .blend round-trip.** `load_post` handler auto-reloads the
  track JSON when a `tracks-src/<id>.blend` opens (gate spacing, terrain
  shader, water knobs, start pose). Export merges Blender-owned fields
  onto whatever the editor last saved; legacy `cp_NN` / `pickup_*`
  empties still win when authored locally. Manifest upsert ensures
  addon-authored tracks surface on the level-select screen without a
  separate `pnpm gen:tracks` step.
- **Live previews follow source edits.** Debounced
  `depsgraph_update_post` handler watches `ai_spline_main`, `start_00`,
  `water_volume_main` and rebuilds gate / turn / racer / water previews
  ~200 ms after the user releases. Scene-prop `update=` callbacks for
  spacing, curb dims, wave time go through the same scheduler so
  slider scrubs are live.
- **Two new showcase tracks.** `tracks-src/oval-loop.blend` and
  `tracks-src/figure-eight.blend` were built end-to-end through the
  addon (apply GN island → snap spline → build road with curbs → drop
  ramps → export) and ship as the canonical proof that the authoring
  stack produces playable maps without leaving Blender.

### Authoring — gate placement (2026-05-11)
- **Editor** `?edit=1` has a new "Auto-place gates from spline" button.
  Resamples the main AI spline by arc length at the track's `gateSpacing` (default 60m) and rebuilds the `checkpoints` array with new `splineT` values. One-shot: gates stay individually editable
  afterwards.
- **Blender addon** has matching "Rebuild Gate Preview" / "Hide
  Gate Preview" buttons in the N-key Hoverbike tab. Builds a
  render-disabled `_hoverbike_gate_preview` collection so the
  gizmos never reach the exported `.glb`. See
  [docs/blender-wishlist.md](./blender-wishlist.md) for the full
  Item 2 writeup.
- **Blender addon** also has "Rebuild Racer Preview" / "Hide Racer
  Preview" buttons that drop a bike silhouette at `start_00` plus
  the AI grid. Grid offsets come from
  [`specs/grid-offsets.json`](../specs/grid-offsets.json), shared
  with `src/boot/spawn-bikes.ts` so what you see in Blender matches
  what spawns in-game. See Item 7 in
  [docs/blender-wishlist.md](./blender-wishlist.md).
- **Vertex attribute spec** locked. Procedural assets carry a
  canonical `COLOR_0` attribute; foliage uses R/G/B/A for
  sway/AO/phase/free, terrain reuses it for AO + path-worn mask
  + biome blend. See [docs/vertex-attribute-spec.md](./vertex-attribute-spec.md).
  Shared sway hook at `src/engine/render/foliage-sway.ts`;
  Blender authoring helper at `tools/blender/vertex_attrs.py`.
  Nothing in-game uses it yet — scaffolding for Items 3/4.
- **Water preview** in Blender — "Rebuild Water Preview" / "Hide
  Water Preview" buttons drop a vertex-displaced plane around
  `water_volume_main` using the same 6-wave Gerstner preset the
  runtime ships. Adjustable size / subdivisions / sample time via
  N-key panel. See Item 5 in [docs/blender-wishlist.md](./blender-wishlist.md).
- **Scatter pipeline** now round-trips Geometry Nodes instances as
  `EXT_mesh_gpu_instancing`. Blender exports it; Three.js's
  `GLTFLoader` produces `InstancedMesh` automatically; the collider
  pass skips instanced meshes so scatter is render-only by default.
  Authoring convention: a top-level Empty named `scatter_<zone>`
  with a Geometry Nodes graph below it producing instances.
  See [docs/blender-pipeline-guide.md#scattered-props-item-4](./blender-pipeline-guide.md#scattered-props-item-4).
- **Turn indicators** in Blender — "Rebuild Turn Indicators" /
  "Hide Turn Indicators" buttons drop chevron arrows at high-
  curvature spots along `ai_spline_main`. Threshold + min-spacing
  adjustable from the N-key panel. Defaults pick out ≤50m-radius
  corners.

## Controls

### Keyboard
Default bindings (all eight driving actions are rebindable via
Settings → Controls → Rebind keyboard):

| Key | Action |
|---|---|
| W / ↑ | Throttle forward |
| S / ↓ | Brake / reverse |
| A / ← | Steer left |
| D / → | Steer right |
| E | Pitch up (nose up — lift / jump off a wave) |
| Q | Pitch down (nose down — dive into a wave; feather it into the tuck sweet spot for a speed bonus, bury it and the belly scrapes) |
| Z | Trick left / **hold + steer left = drift left** (release fires the tier 1/2/3 mini-turbo) |
| C | Trick right / **hold + steer right = drift right** |
| Space | Fire pickup |
| Shift (L/R) | Boost |
| Backspace | Respawn at start (snaps to spawn pose, zero velocity) |
| T or F1 | Toggle auto-play (AI drives player bike) |
| M | Toggle audio mute |
| R | Restart race after finish |

All keyboard axes are smoothed (~0.13s ramp) so taps give small inputs and holds give full deflection.

### Gamepad (Xbox / PS layout)
Stick + trigger axes are fixed on the W3C standard mapping (tune feel
via Settings → Controls → sensitivity / deadzone). Fire + boost are
rebindable via Settings → Controls → Rebind gamepad.

| Input | Action |
|---|---|
| Left stick X | Steer |
| Left stick Y | Pitch (push forward = dive / tuck, pull back = jump) |
| Right trigger (RT / R2) | Throttle |
| Left trigger (LT / L2) | Brake (held with no throttle = reverse) |
| Right stick | Camera orbit (Y invert in Settings → Controls) |
| LB / L1 (button 4) | Trick left / **hold + steer left = drift left** — default |
| RB / R1 (button 5) | Trick right / **hold + steer right = drift right** — default |
| X / Square (button 2) | Fire — default (relocated off the bumpers so L1/R1 own the trick/drift channel) |
| Y / Triangle (button 3) | Boost — default |
| A / Cross (button 0) | Throttle (digital alt to RT) |
| B / Circle (button 1) | Emergency brake |

### Mouse
| Action | Effect |
|---|---|
| Right-button drag | Orbit camera around bike (Y inverted by default) |

## Tech stack (locked)

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, exactOptionalPropertyTypes) |
| Build | Vite 8, port 5191 |
| Package mgr | pnpm 10 |
| Renderer | Three.js, WebGPURenderer with WebGL2 fallback (real adapter probe) |
| Physics | `@dimforge/rapier3d-compat` (deterministic build) |
| ECS | bitECS 0.4 with side-table data stores (`engine/sim/ecs/store.ts`) |
| Input | Native gamepad/keyboard API, smoothed |
| Audio | Web Audio API, procedurally synthesised (no SFX assets needed) |
| Test (unit) | Vitest (sim layer only — no Three.js imports) |
| Test (e2e) | Playwright (real Vite dev server, real WebGPU/WebGL2) |
| Lint/format | Biome 2 |
| Hosting | Vercel (push-to-deploy) |
| Source | https://github.com/occ-matt/hoverbike (private) |

See [implementation-plan.md](./implementation-plan.md) for repo layout and the architectural rule (sim layer must not import Three.js).

## Known bugs / quirks

### Multiplayer e2e coverage — *deferred*
M10.11 transform-snapshot sync is covered by unit tests
(`host-election`, `transform-snapshot`, `apply-snapshot`) and was
verified end-to-end via Chrome MCP for solo / two-peer / late-joiner
scenarios. A two-tab Playwright probe (`tests/e2e/m10-11-state-sync.spec.ts`)
was sketched in the design doc §10 but is not yet automated. Bugs
that only manifest cross-tab need to be reproduced manually until
that lands. Good first-PR target for someone with Playwright
experience — design notes in [`docs/m10-11-state-sync.md`](./m10-11-state-sync.md).

### Cliffside AI mesa recovery — *open level-design fix*
Detailed in [AI navigation — Lagoon solid, Cliffside still rough](#ai-navigation--lagoon-solid-cliffside-still-rough)
below: AI bikes that fall off the Cliffside mesa mid-corner can't
get back up. The decision is to widen the mesa / add side ramps in
Blender rather than write code-level recovery logic. Tracked here
so external playtesters / contributors don't file it as a regression.

### Pitch + roll coupling — *resolved (M9.4)*
M9.3 was insufficient: pitching while turning produced wild roll oscillations (probe showed ±60° pitch, ±70° roll). Root cause was the roll PD reading `bikeRight.y` and false-positiving on the geometric tilt that yaw-while-pitched produces; the corrective torque pumped real angular velocity into the roll axis. M9.4 replaces the soft PD with a kinematic roll lock: at the top of `hoverSystem`, decompose the bike's rotation into YXZ Euler (yaw → pitch → roll), force roll = 0, recompose, and strip out the `bikeFwd` component of angvel. Roll velocity can no longer accumulate from misaligned-axis side-effects. Yaw + pitch behave as before.

### Surface follow is altitude-faded (M9.22) — *load-bearing for "hover" feel*
`stats.surfaceFollow` sets the *peak* responsiveness; what actually gets applied to `surfacePitch/RollTarget` is `surfaceFollow * altitudeFactor`, where the factor falls linearly from 1.0 at the surface to 0 at the grounded/airborne boundary (`groundDistance = hoverHeight * 1.6`). At nominal hover (`groundDistance ≈ hoverHeight`) the factor sits around 0.37, so the effective racer follow is ~0.19 instead of the configured 0.5. Why: pre-M9.22 the bike read every wiggle of the wave normal at all altitudes, which made it read like a jet ski more than a hovercraft. Now dipping into a trough kicks the reaction back up while cresting a wave eases it off, so terrain interaction is strongest exactly when the bike is closest to the terrain. If wave riding feels too floaty, widen the fade (e.g. fade to 0 at `hoverHeight * 2.0` for a longer band) or raise the per-bike `surfaceFollow`. Implementation in `src/game/systems/hover.ts` inside the `isGrounded` branch.

### Underwater dive feel (M9.23) — *load-bearing for "Wave Race" feel*
Below the water surface (`groundDistance < 0` on water), the hover spring
is replaced by depth-proportional buoyancy + asymmetric quadratic drag.
Plus the above-water `hoverDamp` is now one-sided (only damps **upward**
velocity) so dive momentum off a ramp can punch through the spring zone
instead of braking before reaching water. Constants in
[hover.ts](../src/game/systems/hover.ts): `BUOYANCY_PER_M = 14`,
`BUOYANCY_CAP = 20`. Drag is split: `DRAG_K_HORIZ = 0.1` (always),
`DRAG_K_SINK = 0.1` (Y-axis, full strength while sinking — kills dive
momentum), and `DRAG_K_RISE = 0.03` (Y-axis, much weaker on the rise so
accumulated buoyancy slingshots the bike out instead of being fought by
drag). Gravity is canceled in the underwater branch so buoyancy is the
net upward force — this decouples buoyancy tuning from gravity. Empirical
shape: a hard ramp landing reaches ~1.0–1.3m peak submersion (whole
capsule under), the bike slows visibly, then pops back to ~3m above
water; gentle wave-trough dips reach ~0.2–0.3m and read as a splash. If
the slingshot feels too aggressive, raise `DRAG_K_RISE` toward 0.06–0.08;
if the bike feels too buoyant, lower `BUOYANCY_CAP`. The water mesh now
uses `transparent: true, opacity: 0.75` so the submerged portion is
visible.

### Bike wakes are physical, not cosmetic (M9.26) — *load-bearing*
The water shader's V-stripe behind each bike used to be foam-only. As of
M9.26 the same wake function (a transverse-feathered sine, decaying
exponentially behind the bike) also displaces the water *and* contributes
to buoyancy via the sim's `WaveFieldState.wakes` array. Result: a trailing
rider can feel and "jump" the leader's wake. The wake math lives in
`engine/sim/water/wave-field.ts` (`sampleWakeFromSource`), is mirrored
bit-for-bit in `engine/render/water.ts` (`wakeSum` Fn block in the TSL
shader), and the same constants (`WAKE_DISP_AMP`, `WAKE_DISP_WAVELENGTH`,
`WAKE_DISP_OMEGA`, decay/ramp/feather) are imported from the sim module so
they can't drift apart. `wakeUpdateSystem` (in `game/systems/wake-update.ts`)
populates `field.wakes` once per fixed step BEFORE `hoverSystem` reads the
surface — that's what makes the lead bike's wake felt by trailing
buoyancy. The bike's own wake doesn't affect itself (`behind > 0` gate).

Vertex subdivisions: 192 (1.25 m spacing on the 240 m plane), with
`WAKE_DISP_CULL_R = 40 m` early-out per-bike per-vertex. Tests run headed
(real GPU) via `playwright.config.ts` — the headless WebGL2 software
fallback (SwiftShader) tanks any non-trivial vertex shader to single-digit
fps under parallel workers. Set `E2E_HEADLESS=1` to opt back into headless
(e.g. CI without a display).

### Periodic swell sets (M9.26)
`defaultWaves()` now includes two long-wavelength swells (60 m + 85 m,
amplitudes 0.55 m + 0.4 m) with slightly different periods (~6.0 s vs
~7.7 s). They beat against each other so big "sets" come in roughly every
25–30 s automatically (constructive interference of two sines = no extra
logic needed). Four chop bands fill in surface texture across multiple
scales (22 m down to 5.5 m).

### Water v2 — SoT-style ocean (M9.29) — *load-bearing for "feel"*
Five-piece upgrade in [`src/engine/render/water.ts`](../src/engine/render/water.ts) and [`src/game/systems/hover.ts`](../src/game/systems/hover.ts) inspired by
the SIGGRAPH 2018 *Technical Art of Sea of Thieves* talk and the Atlas GDC
2019 wave-physics talk:

1. **Horizontal-displacement Gerstner** (render only) — vertices now displace
   both vertically AND laterally per GPU Gems Ch.1 eq.9 + 13:
   `P.x += Σ Q·A·D.x·cos(phase); P.z += Σ Q·A·D.z·cos(phase)`. Crests pinch
   into ridges instead of round bumps. Per-wave Q baked in `Q_BASE_DEFAULTS`
   (`[0.35, 0.35, 0.85, 0.95, 1.0, 1.0]` — swells gentle, chops sharp). All
   waves multiplied by a global `steepnessUniform` (default 0.7, scrub via
   `__waterSteepness(n)` in console; URL `?steep=N` overrides initial).
   Surface normal uses GPU Gems eq.13 `(-Σdy/dx, 1−Σ Q·k·A·sin, -Σdy/dz)`,
   which collapses to the old heightfield normal at Q=0.
2. **Two-color scatter blend** — deep teal `(0.02, 0.12, 0.22)` ↔ scatter
   cyan-green `(0.22, 0.7, 0.65)`, modulated by both wave height AND view
   angle. Crest backs and grazing-angle samples brighten via `mix(0.55,
   1.0, 1−ndotv)`. Approximates sub-surface scattering without a sun
   direction.
3. **Foam: physically-correct triggering** — replaced the height-driven
   `smoothstep(height) + 0.5·smoothstep(slope)` with `max(slopeFoam,
   foldFoam) · heightGate`, where `foldFoam = smoothstep(0.12, 0.35,
   qSum)` reads the GPU Gems Jacobian-onset signal (the surface is
   approaching fold-back — physically what produces whitecaps). Height now
   gates rather than drives, so tall-but-flat swells don't foam and only
   actively-breaking faces show whitecaps.
4. **Multi-probe buoyancy** — `hoverSystem` was sampling the wave field at a
   single point (the bike's center) and reading the local normal for
   pitch/roll. Now samples height at four points around the bike — bow,
   stern, port, starboard (`PROBE_HALF_LENGTH = 0.8m`, `PROBE_HALF_WIDTH =
   0.4m` matching the bike's visual footprint) — and lets pitch/roll fall
   out of differential heights:
   `pitch ≈ atan2(yBow − yStern, 2·halfLength)`,
   `roll ≈ atan2(yStarboard − yPort, 2·halfWidth)`.
   This is the SoT/Atlas approach. Wins: long swells naturally tilt the
   bike across the wave; short chops average between probes so the bike
   doesn't whip-snap to ripples shorter than its own footprint. Same
   altitude-fade and kinematic attitude system as before; just better
   targets.
5. **Noise-modulated specular** — `mat.roughnessNode = mix(0.18, 0.04,
   broadMask)` where `broadMask` is a low-frequency animated hash gated to
   crests. Highlights tighten in patches and drift with time, producing
   the SoT "wandering glints" look instead of a uniform sheen.

Debug toggles: `?water=classic` (entire upgrade off — original colors,
vertical-only Gerstner, original roughness, original foam), `?wire=1`
(orthogonal — works with classic and v2), `?steep=N` (initial steepness
override, 0–1.5).

Physics-side note: `wave-field.ts` (CPU buoyancy) keeps the simpler
vertical-only formulation. With moderate Q the rendered surface and the
buoyancy field stay within ~0.4 m horizontally — well below visible
disconnect for a hoverbike skimming the surface. If steepness goes much
past 1, consider a Newton iteration on the CPU side to recover the rest
position from world XZ.

Planar reflection landed in M9.38 — the water surface mirrors bikes / sky /
terrain via TSL's built-in `reflector()` node, distorted by the wave normal
and Fresnel-mixed into the base color. SSR (true screen-space reflection
of arbitrary scene depth) is still deferred and likely overkill for an
arcade racer; see [docs/water-deep-dive.md](./water-deep-dive.md) for the
full research and prioritization.

### Water — sun-direction backscatter (M9.30)
Threads the directional light vector through to the water shader as a
uniform `sunDirUniform` (matches scene.ts's sun position 50,70,70
normalized; a future day/night cycle can animate it). Two related
additions:

1. **Scatter blend bumped by sun alignment.** `scatterAmount` now stacks
   `sunBackscatter = pow(max(0, dot(line-of-sight, toward-sun)), 2)` on
   top of the existing view-angle scatter. Camera looking toward the sun
   → tall waves between camera and sun bump scatter further toward
   cyan-green.
2. **`sunGlow` emissive.** The unmistakable SoT "lit-from-behind"
   wave glow. `scatterColor · sunBackscatter · heightFactor · 0.6`,
   added to `emissiveNode` alongside the existing fresnel + sparkle
   terms. Off in classic mode for clean A/B.

Hoisted `heightFactor` out of the IIFE so both the scatter blend and
the new sun-glow share it. No physics change.

### Water — planar reflection (M9.38)
The water surface now mirrors the scene — bikes, props, terrain, and sky
all show up in the reflection, distorted by the wave normal so the mirror
image ripples with the surface. Implementation uses Three.js's TSL
[`reflector()`](https://github.com/mrdoob/three.js/blob/master/src/nodes/utils/ReflectorNode.js)
node, which manages a virtual mirror camera + half-resolution render
target internally. Each frame the reflector renders the scene from the
camera reflected across the water plane (y = 0), into a half-res target,
which the water shader samples via `screenUV` (the reflector's default
UV node, with our wave-gradient distortion added on top).

Key wiring choices in [`src/engine/render/water.ts`](../src/engine/render/water.ts):

1. **Mirror plane = the camera-locked water mesh.** The reflector's
   `target` Object3D is parented to the water mesh with `rotation.x =
   -π/2`, so its local +Z (= the plane's normal direction) aligns with
   world +Y. The mesh slides under the camera in X/Z each frame, but
   reflection across an infinite horizontal plane is independent of the
   in-plane offset — only the world-Y of the target matters, and that
   stays at 0.

2. **Distortion from wave gradient.** The varying'd surface normal slopes
   `dydx`/`dydz` are added to the reflector's UV, scaled by an
   inverse-distance factor: `0.02 + 0.6 / (camDist + 2)`. Closer waves
   distort visibly while horizon samples stay nearly mirror-flat — the
   same trick the Three.js WaterMesh example uses, sized for our wave
   amplitudes. Without distortion the mirror image looks glassy and the
   wave geometry feels disconnected from what's painted on it.

3. **Fresnel-weighted blend, not full replace.** Reflection strength is
   `Schlick fresnel × 0.85` — 85% reflective at grazing angles, ~2% at
   the zenith (the F0 = 0.02 floor is correct for water). The remaining
   15% at grazing keeps a hint of the deep/scatter color in the surface
   so it reads as "water reflecting" rather than "mirror painted on
   water". Mixed BEFORE foam is composited so foam stays opaque white
   where it fires (foam is water particles, not the surface — it
   shouldn't reflect).

4. **Replaces fresnelEmissive sky tint.** The pre-M9.38 grazing-angle
   bright band was a fake `skyTint × fresnel` emissive — a stand-in for
   the sky reflection. With the real reflection in place, that fake is
   redundant (the actual sky is now in the reflection texture) and
   stacking both reads as chrome. The fake is preserved in classic
   mode (`?water=classic`) and `?reflect=0` so the A/B comparison still
   shows the same baseline as before.

Cost: one additional render pass at 0.5× resolution scale per frame.
On a 1080p framebuffer that's a 540p target — a few hundred k pixels —
trivial on real GPUs (130–180 fps unchanged on WebGPU). The reflector's
internal `bounces: false` short-circuits the (would-be infinite) recursion
of nested reflectors, and its `forceUpdate = false` skips the render
entirely when the camera is looking up from below the water (the
reflector would have nothing to mirror in that case).

Debug knob: `?reflect=0` falls back to the fresnelEmissive sky tint for
A/B; classic mode (`?water=classic`) also disables it, since classic was
authored against the sky-tint emissive.

### Water — wake transverse "scallops" (M9.35)
The wake's static Kelvin V is now modulated by `sin(K · behind − ω · t)`,
producing the transverse oscillating ridges seen in real ship wakes —
the wake feels alive instead of stamped. Same modulation is mirrored
bit-for-bit in `sampleWakeFromSource` (sim) and the shader's wake block,
so trailing riders feel the same scallops they see.

Constants in [wave-field.ts](../src/engine/sim/water/wave-field.ts):
- `WAKE_TRANS_K = 0.7` rad/m → wavelength ≈ 9m, ~3 visible scallops in
  the 25m wake length. Chosen so `sin(K · 10) > 0` at the existing
  unit-test sample point (behind=10, t=0), keeping the V-edge / V-axis
  threshold assertions firmly in the pass region.
- `WAKE_TRANS_OMEGA = 1.0` rad/s → period ≈ 6.3s, gentle backward scroll.
- `WAKE_TRANS_AMP = 0.3` → wake amplitude varies between 0.7× and 1.3×
  along each scallop period.

A new unit test (`wake has transverse oscillation along its length`)
samples the V-edge height at 0.25m steps over [3..30]m behind and
asserts ≥4 direction changes — proves the modulation is actually
oscillating (pure exponential decay is monotonic).

The wake's analytic gradient drops the longitudinal modulation's
∂y/∂behind term — same approximation the existing wake gradient
uses for longRamp/longDecay derivatives. Means the scallop heights
are visible but the per-scallop SHADING is smooth (no bright/dark
banding from a precise normal). Acceptable arcade tradeoff; if
scallops ever read insufficiently 3D, add `cos(longPhase) · K · amp`
contribution to dydx/dydz.

### Water — chop bump + day-night sun cycle (M9.34)
Two quick wins from the [water deep-dive](./water-deep-dive.md):

1. **Chop amplitudes bumped 30%** in [`defaultWaves()`](../src/engine/sim/water/wave-field.ts):
   `[0.5, 0.34, 0.22, 0.12]` → `[0.65, 0.44, 0.29, 0.16]`. Shorter
   wavelengths now pinch more dramatically with the horizontal Gerstner
   from M9.29 — chop ridges read as actual ridges instead of soft bumps.
   Swell amplitudes left untouched (they drive the periodic-set rhythm
   and bumping them risks the buoyancy field throwing the bike around
   at race speeds). Multi-probe buoyancy (M9.29) absorbs the extra
   short-wavelength chop without the bike whipping — chop wavelengths
   (5.5..22m) are mostly close to or smaller than the bike's 1.6m
   probe footprint, so probe averaging mutes the worst of it.

2. **Day-night sun cycle.** Animates the directional light's position
   on a 360s loop. Elevation oscillates 30°..70°; azimuth rotates a
   full 360°. The water shader's `sunDirUniform` is updated in lockstep
   via `waterMesh.setSunDirection(...)`, so the sun-glow on backlit
   waves drifts across the scene as the race progresses. Driven by the
   deterministic `waveField.time` clock so a replay puts the sun back
   where it was. Implementation: `createScene()` now returns the
   `THREE.DirectionalLight`; `WaterMesh.setSunDirection(x, y, z)`
   normalizes the input and writes to the shader uniform; the per-frame
   block lives in [main.ts](../src/main.ts) right after `waterMesh.tick`.
   No shadow rendering yet, so the most perceptible effect is the
   water's sun-glow direction shift.

Tunables in `main.ts`'s sun-cycle block: `SUN_CYCLE_SECONDS` (360),
`SUN_RADIUS` (110), elevation range `(50 ± 20)°`. Make the cycle
faster for visible mid-race drift; slower for a more cinematic feel.

### Water — shoreline lapping + wake polish (M9.33)
Round of polish on the foam pass shipped in M9.32:

1. **Shared `foamTurbulence` field.** A world-XZ + time-scrolled hash
   noise used by shoreline foam, wake, and bow spray to break up their
   otherwise-too-clean edges. Multiplier in `[0.5, 1.0]` so foam is
   never erased — just patched into turbulent intensity. NOT applied to
   wave-driven foam (slope/Jacobian/accumulator), since natural whitecap
   foam already has its own variation from the wave field — adding more
   noise on top reads as TV-static. Shoreline, wake, bow spray, and
   stern propwash now share a unified visual rhythm.

2. **Shoreline lapping.** The depth threshold for shoreline foam now
   breathes ±0.4m around its 1.5m base via `foamNoiseRaw - 0.5`. Where
   the noise is high, foam reaches further off-shore (1.9m); where low,
   it pulls back (1.1m). Combined with the static depth intersection,
   this reads as the surf "lapping" against the shore rather than a
   fixed water-line. Verified by capturing two ramp shots 2s apart —
   foam coverage differs visibly between frames.

3. **Stern propwash.** Bright concentrated foam directly behind the
   bike (~0.3m back, fades to 0 by ~2.5m, centered on the wake axis).
   Distinct from the V-wake outline — the propwash is a solid mass of
   foam that the bike actively generates, what gives the wake its
   kinetic "boat is here" feel rather than a pure outline. NOT
   noise-modulated — it's the bike's "exhaust" foam.

4. **Wake + bow spray noise modulation.** Both get multiplied by
   `foamTurbulence`, so their edges break up into patches instead of
   reading as stamped templates. The same noise field also drives the
   shoreline lapping, giving all interactive foam a unified visual
   character.

No physics change. No per-vertex cost added; the foam noise is one
extra hash per fragment (negligible).

### Water — shoreline foam + richer bike foam pass (M9.32)
Water-on-land transitions are a recurring on-track moment (lagoon ramp,
gate posts, cliffside cliff base, future islands), so the water shader
gained a depth-buffer-driven shoreline foam plus a richer bike-water
interaction pass.

> **Regression test:** drive `?track=foam-test` —
> [`public/tracks/foam-test.json`](../public/tracks/foam-test.json) is a
> static demo scene (cylinders / spheres / boxes / pipe / halfpipe at
> assorted submersion depths) authored specifically to make missing
> intersection foam impossible to overlook. If you change anything in
> the foam pass, eyeball this track first.

1. **Shoreline foam (intersection foam).** Reads the opaque-pass scene
   depth at each fragment's screen position, converts to view-Z via
   `perspectiveDepthToViewZ(near, far)`, and compares to the water's own
   `positionView.z`. When the difference is small (terrain top ~0–1.5m
   below water surface) → foam. Two gates handle edge cases:
   `behindGate = smoothstep(-0.05, 0.05, closenessSigned)` ensures
   opaque objects rendered IN FRONT of water (e.g. bikes between camera
   and water surface) don't false-trigger foam where they occlude the
   water plane; `depthFade` controls the falloff over `FOAM_INTERSECTION_RANGE = 1.5m`.
   Combined with the existing wave/bike foam via `max()` rather than
   addition so gate posts don't get unnaturally over-bright at the
   water-line. Off in classic mode for clean A/B.

   Depth source (load-bearing): the shader does NOT use Three.js's
   `viewportDepthTexture()` helper. Under WebGPURenderer that helper's
   `updateBefore` fires at the very start of the render pass — before
   any opaque has been encoded — so the captured depth buffer is at the
   clear value (= 1.0 = far plane) and the comparison reads the entire
   scene as "infinitely far," producing zero foam. Instead the water
   mesh holds its own `THREE.DepthTexture` and copies the live
   framebuffer depth into it from `mesh.onBeforeRender`; by the time
   that callback fires for the (transparent) water object, all opaques
   have been encoded into the same pass, so the snapshot reflects real
   post-opaque depth. See `sceneDepthTexture` in
   [src/engine/render/water.ts](../src/engine/render/water.ts).

2. **Richer bike foam pass.** Two additions on top of the existing hull
   ring + V-wake stripe:
   - **Speed-modulated hull ring**: `ring · (1 + 0.6·speedGate)` —
     ring foam reads ~1.6× brighter at race speeds vs. idle, communicating
     the hull's active interaction with the water.
   - **Bow spray ("moustache")**: forward-facing foam arc using the same
     Kelvin-V geometry as the back wake but with a tighter half-angle
     (0.35 vs the wake's 0.4 tan) and a faster `exp(-1.6·ahead)` longitudinal
     falloff. Speed-gated, so a parked bike doesn't spray. Reads as the
     bike actively pushing water forward at race pace.

Per-fragment cost stays trivial — one extra texture sample for the
depth read, plus a few muls/adds for the bow spray geometry. No
per-vertex cost. Renders correctly through the existing transparency
sort (water is rendered after opaque, so the depth buffer is populated
with terrain depth at water-shade time).

### Water — stateless foam accumulator (M9.31)
Foam now lingers ~1s behind passing crests instead of vanishing the
moment the wave moves on — the "trail" character of real ocean foam.
Implementation: since waves are deterministic functions of `(x, z, t)`,
"did this position have a crest 0.5s ago?" reduces to evaluating
`gerstner(x, z, t-0.5)`. The `foamAccumulator` Fn samples 4 time steps
in the recent past (`Δt = 0.25s`, total window = 1s), computes
`max(slopeFoam, foldFoam)` at each, decays exponentially
(`exp(-Δt · 1.5)` → half-life ≈ 0.46s), and reduces to the max. The
result is forwarded to the fragment as a single varying.

This is the cheap stateless cousin of SoT's persistent foam texture
(which uses an FFT Jacobian + render-target ping-pong). Per-vertex cost
goes from 24 trig to ~120 trig (4 extra Gerstner-pair samples) — well
within the per-frame budget on any real GPU. Wakes are NOT included in
the time history (would need historical bike positions); wake foam
stays current-time only via the existing `bikeFoam` path.

Side effect: the height gate on wave foam is dropped in v2 mode — foam
is allowed to persist on what's now a trough if it WAS a crest a moment
ago. This is physically correct (foam is water particles, not the wave
shape) and visually closes the gap with SoT considerably. Classic mode
keeps the height-gated current-time foam for clean A/B.

### e2e runs headed by default (M9.26)
The GPU water shader is happy on real hardware but the headless WebGL2
software fallback (SwiftShader) drops to single-digit fps under any
non-trivial vertex/fragment work. `playwright.config.ts` now defaults to
headed, opting in to the real GPU; set `E2E_HEADLESS=1` to flip it back
(e.g. CI without a display server). A pop-up Chromium window per worker
during local `pnpm e2e` is the visible side effect.

### Unified multi-probe surface alignment (M9.37)
Auto-orient ground branch (M9.36) reworked to use the same 4-probe footprint
sampling as water — bow / stern / port / starboard, each taking
`max(ground raycast, wave field height)`. Wins:

- **Sub-footprint terrain bumps average out.** A trimesh ramp lip or rocky
  patch shorter than the bike's 1.6m × 0.8m footprint gets averaged across
  probes instead of whip-snapping the chassis to a single normal.
- **Mixed water/terrain transitions read continuously.** Bow over a ramp
  while the stern is still on a wave, or bike straddling a shoreline lip:
  each probe independently picks its surface, so the differential height
  smoothly transfers from "rolling on water" to "climbing the ramp" with
  no isWater-branch flicker.
- **One code path.** Single multi-probe block runs whether the center
  probe is over water, over ground, or transitioning. The center probe's
  `isWater` only picks the *baseline follow strength* (water uses per-bike
  `surfaceFollow` for chop dampening; ground uses 1.0 for full ramp match).

The single-normal `castRayAndGetNormal` path from M9.36 is retired —
`probeSurface` is back to a plain `castRay`, and a new `probeSurfaceY`
helper does the four corner casts (returns max of ground+water; falls
back to the center probe's surface if neither side hits, e.g. bike
overhanging a cliff edge).

Cost: 5 raycasts per bike per fixed step (1 center + 4 corners) instead
of 1. With ~5 bikes that's 25 raycasts at 60Hz = ~1500/sec, well under
Rapier's broadphase ceiling.

### Feel pass — lean curve, slope momentum, mobile pitch invert (M9.40)
Three independent tweaks in [`src/game/systems/hover.ts`](../src/game/systems/hover.ts) and [`src/engine/input/touch.ts`](../src/engine/input/touch.ts):

1. **Lean curve grows past full-speed.** `ROLL_LEAN_LIMIT` bumped from
   `π/15` (~12°) to `40°` (M9.40 → M9.41 crank-up — the original 20°
   step still read as "tilting" rather than "committing"). The
   speed→lean ramp is two-stage: a base ramp `LEAN_BASE → 1.0` over
   `[0, LEAN_SPEED_FULL = 6 m/s]`, plus a second ramp `0 →
   LEAN_HIGH_SPEED_BOOST (= 0.5)` over `[LEAN_SPEED_FULL,
   LEAN_SPEED_HIGH = 24 m/s]`. Net result: stationary bike at full
   steer leans ~16°, "moving normally" leans ~40°, and at top speed
   the racer lays over to ~60°. The two-stage shape preserves the
   existing low-speed feel (parking, garage) while making racing
   visibly committed — the bike actually puts a knee down through the
   apex.

2. **Slope momentum.** Previously the chassis tilted to track the
   surface but horizontal speed was independent of the wave face — going
   down a wave was no faster than going up one. The thrust block now
   projects gravity along the bike's horizontal forward axis:
   `aSlope = -fwd.y · GRAVITY · SLOPE_MOMENTUM` where `SLOPE_MOMENTUM =
   0.55`. Nose-down (`fwd.y < 0`, e.g. cresting onto the leeward face of
   a swell) accelerates downhill; nose-up decelerates. The hover spring
   already cancels gravity vertically — without this the chassis pitched
   but coasted at the same horizontal speed regardless of the slope.
   Limited to the grounded thrust path (above-water hover and on-ground)
   so airborne ballistic and underwater dive dynamics are unaffected.
   Coefficient kept well below 1.0 so a steep ramp doesn't slingshot
   past `topSpeed` (the existing `speedFalloff` already taps that off
   for *thrust*, but slope momentum is added on top).

3. **Mobile virtual-joystick Y inverted.** The touch stick was mapped
   "stick up → pitch +1 → nose UP / lift", which contradicted the
   gamepad ("push forward = dive") and the flight-stick convention. Now
   `intent.pitch = clamp(0 − sy, −1, 1)`: stick up → nose down dive,
   stick down → lift. The `0 − sy` form (rather than unary `−sy`)
   preserves `+0` so the deadzone path returns `+0` rather than `−0`
   (Object.is-equality breaks otherwise). Touch unit tests flipped to
   match the new convention; gamepad and keyboard mappings are unchanged.

### Pitch heaviness + lean baseline + auto-orient to ramps (M9.36)
Three feel passes on the chassis controller in
[`src/game/systems/hover.ts`](../src/game/systems/hover.ts):

1. **Pitch smoothing.** Kinematic pitch was previously snap-to-target each
   fixed step (effectively rate=∞), which read as twitchy on the stick.
   The kinematic pitch now lerps toward target with two
   exponential rates: `PITCH_RATE_ACTIVE = 12` (≈250 ms to 95% while the
   stick is held) and `PITCH_RATE_RELEASE = 3` (≈1 s to 95% when the
   stick is at neutral). The 4× release-vs-active ratio is intentional:
   letting off the stick should feel *heavy*, like the bike retains its
   attitude instead of snapping back. Side effect: the bike holds its
   launch angle for ~1 s after leaving a ramp (since `surfacePitchTarget`
   drops to 0 when airborne but the lerp drains it slowly), which reads
   as natural "ballistic carry" rather than an instant pop to flat. Roll
   still snaps — steer-driven lean is meant to read instant.

2. **Lean baseline (`LEAN_BASE = 0.5`).** Previously the steer-driven roll
   lean scaled linearly from 0 at zero forward speed to full at 5 m/s. Now
   it's `LEAN_BASE + (1 − LEAN_BASE) · min(speed/5, 1)`, so a stationary
   bike at full steer leans 50% of the limit (~6°), and the lean ramps to
   the full 12° once moving at speed. The bike "knows" it's turning even
   when parked — feels less like a static prop on a turntable when
   maneuvering at low speed.

3. **Auto-orient to ramps.** `probeSurface` now uses
   `castRayAndGetNormal`, and the surface-alignment block has a ground
   branch that decomposes the world normal into yaw-aligned components
   and reads pitch/roll directly:
   `pitch = atan2(n_yaw.z, n_yaw.y)`,
   `roll  = -asin(n_yaw.x)`.
   Strength is `GROUND_FOLLOW · altitudeFactor` with `GROUND_FOLLOW = 1.0`
   (vs water's per-bike `surfaceFollow` of 0.5) — ramps are clean
   surfaces that don't need the chop-averaging dampening the water probe
   applies, so the bike fully matches a ramp's slope. The Lagoon ramp
   (14° slope) now reads as the bike "settling onto" the ramp on
   approach and launching from that as its new neutral attitude, instead
   of needing the player to hold pitch+E to compensate.

### Pitch-modulated ride height (M9.24)
Above water, the hover-spring's target height is offset by pitch input:
`effectiveHoverHeight = stats.hoverHeight + intent.pitch * 0.5`. Pulling
back on the stick (`intent.pitch=+1`, nose up) raises the bike by up to
0.5m; pushing forward (nose down) lowers it. The spring's PD smooths the
transition for free — feels like the bike "leans into" the new altitude.
Combined with the existing kinematic pitch tilt this gives a richer
pitch-input feel: pull back → bike rises AND tilts nose up; push forward
→ bike skims AND noses down. Knob is `PITCH_HEIGHT_RANGE` in
[hover.ts](../src/game/systems/hover.ts).

### Pitch + throttle on water — *intentional, not a bug*
Holding `pitch=-1` (dive) at full throttle makes the bike plant its nose into wave troughs and submerge-and-bounce, with speed swinging 10→25→10 m/s as buoyancy kicks back. This is the desired Wave Race-style feel — diving into a wave should *cost* you. Thrust is already projected to horizontal (always was); the apparent "dive" is the bike's collider being driven through the wave field at speed, not a thrust-direction bug. Don't "fix" it.

### AI navigation — Lagoon solid, Cliffside still rough
*Updated M9.15.* The AI now runs a smooth-arc racing spline through the
half-circle curves (`tracks/spline-utils.ts`), and the controller scans
~1.5s of upcoming spline ahead, derives an implied corner radius, and
caps target speed at √(latAccel × radius). Brake fires when current speed
exceeds that target; without this, brake only ever fired *during* a sharp
corner — too late to actually take it.

- Lagoon Loop: autoplay completes a full lap in ~24s game time (the
  `m9-ai-laps` probe asserts ≥10 checkpoint crossings). AI bikes hold
  parallel lines through curves with their per-AI line offsets; no more
  cp 1 / cp 4 overshoot.
- Cliffside: the climb ramp + cliff drop create a dead-end the AI can't
  recover from. If the bike launches off the climb at an angle and lands
  off the mesa, or falls off the mesa mid-curve, it cannot get back up
  to the mesa to cross cps 3 / 4. The bottom half of the track is fine.
  This is a content/level-design limitation, not a controller bug —
  procedural recovery onto a separate elevation surface is non-trivial.
- Per-bike line offsets prevent dogpiles at gates; bumps still happen on
  heavy interactions but no longer compound into pile-ups.

### Curve apex inset (M9.15) — *load-bearing for Cliffside*
The natural radius-50 half-circle through the gates has its apex at
z = ±100, which is exactly Cliffside's mesa edge (mesa half-extent z = 25
around z = 75 → north edge at z = 100). Any inertial overshoot puts the
bike off the cliff on the wrong side. `buildStadiumAISpline` solves the
unique tangent arc that has corner endpoints at (±50, ±50) but apex at
(0, ±92) — 8m inside the mesa edge. APEX_INSET in `spline-utils.ts`
controls the margin; reducing it gives a tighter racing line at the cost
of cliffside safety.

### `quatRotate` was buggy in M0–M3
Fixed in M4 — the `q*v*q⁻¹` expansion was producing wrong rotated vectors except at identity. All systems that read bike orientation were affected; fixing it surfaced the steer-sign issue.

### Steer/yaw torque sign convention is empirical
`aTurn = -intent.steer * turnTorque` — playtest-confirmed but my earlier analysis kept getting it backwards. Document is `hover.ts`. The chase camera makes "physical left turn = perceived right turn" feel correct.

### Pitch sign is empirical too (M9.2)
`aPitch = (currentPitch - targetPitch) * SPRING` — note the order. (target - current) was the wrong sign and produced a backflip when the player pressed E. Document in `hover.ts`.

### Q dives, E lifts — keyboard.ts comments are misleading (M9.18)
Empirically verified by probe + playtest:
- **Q (intent.pitch=-1)** → body fwd.y ≈ **-0.5** (nose visibly DOWN). Player presses Q to **dive**.
- **E (intent.pitch=+1)** → body fwd.y ≈ **+0.5** (nose visibly UP). Player presses E to **lift / extend air**.

The keyboard.ts and intent.ts comments call Q "pitch up = jump off a wave" and E "pitch down = dive". That language describes the rider's body action ("lean back" → Q), not the bike's pitch — which is the opposite. **The visual orientation matches the math:** the YXZ Euler build at `hover.ts:154` does `targetPitch = -intent.pitch * PITCH_LIMIT`, so Q ends up at mathematical pitch +π/6 (R_x(+π/6) sends +Z down to (0, -0.5, 0.866) — fin pointing down). Anything that reads the bike's true forward vector to derive an intent-aligned thrust direction should use `fwd.y` directly — no negation. The air-control system in `hover.ts` does so, which is why throttle + Q drives the bike into the ground and throttle + E lifts it skyward, matching what the player sees.

### Tests sometimes flaky on parallel runs
The M3 race "checkpoints not in front are not counted" test occasionally needs a retry. Cause: physics-driven timing under CPU contention from 4 parallel Playwright workers. Workers capped at 4; retries enabled.

### Other small things
- The "infield island" cylinder in the middle of the loop is decorative — bike drives around it on water.
- Boot sometimes needs a hard reload (Ctrl+F5) after big code changes — Vite HMR can leave stale state in stores.

## What's left to implement

In rough priority order. Each item is sized as **S/M/L** for effort.

### Polish on what exists
- **[S] Pitch attenuation tuning.** Maybe make pitch effect smaller (±15° instead of ±30°) so the bike stays more controllable. Or scale pitch with speed.
- **[S] Air-thrust tuning.** M9.18's `AIR_LIFT_FRAC=0.4` and `AIR_THRUST_MUL=0.7` are first-pass values. Q's lift authority is small in absolute terms (~1–2 m/s² at top speed) because thrust speedFalloff caps it. Bump if the hang-time still feels weak after playtest.
- **[M] Cliffside AI recovery.** When the AI falls off the mesa mid-curve, it can't navigate back up the climb ramp. Either widen the mesa, add side ramps, or teach the AI to detour to the climb ramp when it's off-elevation.

### Combat (M5 — done)
All four MVP pickups landed in M9.9 (the M5-completion bundle):
- **Boost** — speed multiplier (was already in)
- **Shield** — 6s bubble, absorbs one mine/missile hit then consumes
- **Mine** — dropped behind the firer with a 0.6s arming delay; proximity trigger spinouts the victim
- **Homing missile** — target acquisition picks nearest bike inside a forward cone (≤80m, dot ≥ 0.3); MISSILE_TURN_RATE 2.4 rad/s caps how sharply it can chase. 5s self-destruct.

Shared hit reaction: linear-velocity damp ×0.55, ±12 rad/s yaw spinout, 1s `Stun` component that the `stunOverrideSystem` uses to zero throttle/steer/brake/pitch on the victim until it expires. Fire/boost are NOT zeroed during stun.

**AI pickup usage** (M9.10): the four AI bikes now fire their pickups via a new `aiCombatSystem` that runs between `aiControlSystem` and `stunOverrideSystem`. Decision logic is in the pure `shouldAIFire(held, throttle, |steer|, hasChaser, hasMissileTarget)` helper (12 unit tests cover the gates):
- **boost** — fires when `throttle > 0.85` (i.e. on a clean straight; never burns it scaled-down mid-corner)
- **shield** — fires whenever held; sitting on it can't help
- **mine** — fires when a non-self bike is within 12m and behind us (`dot < -0.4`), OR mid-corner (`|steer| > 0.4`) to hazard the racing line
- **missile** — fires when `throttle > 0.8` AND `pickMissileTarget()` finds a bike in our forward cone (≤80m, dot ≥ 0.3)

Open polish:
- Pool weighting feels OK at 2:1:1:1 (boost:shield:mine:missile) but only one race tested it. Tune if combat dominates.

### Missing MVP items
*(MVP feature list is now complete. Remaining work is the asset pipeline + post-MVP polish — see below.)*

### Asset pipeline — *M9.16 + M9.17 + M9.19 + M9.20 + M9.21 live*
Tracks are now hybrid: gameplay data (gates, AI spline, pickups, boost
pads, start, water) lives in `public/tracks/<id>.json`, optionally
referencing a Blender-authored `.glb` for environment geometry. The
in-app editor (`?track=<id>&edit=1`) edits the JSON live and saves via
`/__editor/save-track`.

> **Authoring a new track?**
> - Gameplay placement → [track-editor-guide.md](./track-editor-guide.md)
> - Environment geometry → [blender-pipeline-guide.md](./blender-pipeline-guide.md)
>
> The Blender side now has a one-click **Export to Game** button (install
> `tools/blender/hoverbike_addon.py` once). The button validates the
> scene, writes the GLB, and on first export materialises a starter
> JSON from the .blend's checkpoints / spline / pickups / start. The
> in-app editor's panel has **Open…** and **New…** controls listing
> every track in `public/tracks/` + `public/assets/tracks/`, served by
> a dev-only `/__editor/list-tracks` endpoint.

- ✅ **Track JSON format** at `tracks-src/calibration.json` analogue
  (canonical lives in `public/tracks/calibration.json`). Schema enforced
  by `src/game/tracks/json-loader.ts` (Three-free).
- ✅ **In-app editor** at `src/engine/editor/track-editor.ts` —
  Three.js `OrbitControls` for the camera, `TransformControls` gizmos
  for translate / rotate / scale, side-panel **outliner** listing every
  entity grouped by kind, place buttons (+Gate / +Pickup / +Boost /
  +Spline pt), Save (POST → dev middleware) and Play (reload).
  `?edit=1` defaults to `lagoon-edit` (a JSON snapshot of the procedural
  Lagoon Loop, generated by `tools/snapshot_lagoon.mjs`).
- ✅ **Vite save endpoint** in `vite.config.ts` (`apply: 'serve'`, dev
  only) — strict id regex, atomic write to `public/tracks/<id>.json`.
- ✅ **Build calibration .blend** via `pnpm gen:tracks` (driven by `specs/tracks/calibration.json` + `tools/blender/build_track.py` — replaces the retired `tools/build_calibration_scene.py` as of M9.25)
- ✅ **Export to .glb** via `tools/export_track.py` (legacy all-in-glb
  path; still supported, but the JSON path is preferred for new tracks)
- ✅ **Sim-side legacy loader** at `src/game/tracks/glb-loader.ts` — kept
  for the older all-in-glb format.
- ✅ **Render-side loader** at `src/engine/render/glb-track.ts` — used by
  both pipelines for the visual meshes + collider attach.
- ✅ **Integration test** at `tests/e2e/m9-calibration-glb.spec.ts` —
  asserts the calibration round-trip (now via JSON + env-glb).
- ✅ **Boost pad data type** in `Track`. Renders a cyan slab; sim does
  not react yet (next task).

Open follow-ups:
- **[M] Drivable physics colliders from .glb.** `attachTrackColliders` registers a static trimesh per `kind=track` mesh (with double-winding indices to be normal-direction-independent). `world.castRay` against it returns the expected hit, but Rapier 0.19's broadphase doesn't reliably catch a fast-falling capsule on a thin trimesh plane on its first downward step — the bike tunnels through. The safety floor + universal water surface keep the calibration playthrough sane meanwhile. Likely fix: enable CCD on dynamic bodies + thicken the plane mesh, or switch to Rapier heightfields for terrain.
- **[S] Author Lagoon Loop / Cliffside in Blender.** Procedural tracks remain canonical until physics colliders are reliable.

### Beyond MVP
- Multiplayer (architecturally unlocked by Rapier deterministic build)
- Career mode / unlocks
- Mobile / touch
- Original soundtrack
- In-engine track editor
- Real art direction (placeholders today)

## Milestone status

| # | Title | Status |
|---|---|---|
| M0 | Project skeleton + boot | ✅ |
| M1 | Hover bike on flat ground | ✅ |
| M2 | Wave water + buoyancy | ✅ |
| M3 | Tracks + checkpoints + lap counting | ✅ |
| M4 | AI racers | ✅ (rough cornering remains) |
| M5 | Combat | ✅ — boost, shield, mine, homing missile, hit reaction |
| M6 | Polish to MVP | ✅ — sky/water/UI/audio/2nd-track/garage-menu all in |
| M7 | Real loop track | ✅ |
| M8 | Stadium track + spawn on loop + gate-state fix | ✅ |
| M9 | Smoothed kb + pitch + respawn + arrow + flip recovery | ✅ |
| M9.4 | Kinematic roll lock — pitch+steer no longer rolls the bike | ✅ |
| M9.5 | Bank into turns + lean sign correction | ✅ |
| M9.6 | Surface alignment (kinematic pitch + roll on the wave normal) | ✅ |
| M9.7 | surfaceFollow per-bike stat + per-bike motion trails | ✅ |
| M9.8 | Camera-facing ribbon trails + arrow legibility | ✅ |
| M9.9 | M5 combat bundle (shield, mine, missile, hit reaction) | ✅ |
| M9.10 | AI fires pickups (boost / shield / mine / missile heuristics) | ✅ |
| M9.11 | Jump ramp on right straight — verifies non-water surface behavior | ✅ |
| M9.12 | Procedural audio (engine + ambient + pickup chime + weapon SFX) | ✅ |
| M9.13 | Cliffside track (mesa + ramp + cliff drop) + gate/lap audio | ✅ |
| M9.14 | Bike variants + garage menu + best-lap save state — MVP feature-complete | ✅ |
| M9.15 | AI cornering polish — smooth-arc spline + curvature-aware look-ahead | ✅ |
| M9.16 | Blender → .glb pipeline end-to-end — calibration scene round-trips at runtime | ✅ |
| M9.17 | .glb mesh rendering — track surface visible in scene; collider attach best-effort | ✅ |
| M9.18 | Air control — 40% gravity counter for hang-time + pitch-vectored airborne thrust | ✅ |
| M9.19 | Hybrid pipeline — JSON gameplay data + optional Blender .glb env; in-app editor scaffold | ✅ |
| M9.20 | Editor outliner + Three.js TransformControls (move/rotate/scale); defaults to lagoon-edit | ✅ |
| M9.21 | Editor: undo stack, Catmull-Rom anchor splines (~10 control pts), gates auto-bind to spline | ✅ |
| M9.22 | Altitude-faded surface follow — strong terrain reaction when low, smooth ride when high | ✅ |
| M9.23 | Underwater dive — buoyancy + drag below surface, one-sided hoverDamp, transparent water | ✅ |
| M9.24 | Slingshot pop (asymmetric Y-drag) + pitch-modulated ride height | ✅ |
| M9.25 | GPU water shader (TSL) — Gerstner + dimple + wake foam on the GPU | ✅ |
| M9.26 | Wake displaces water (visual + buoyancy) + periodic swell sets | ✅ |
| M9.27 | Spec → GLB asset pipeline (bikes + props + tracks) — JSON specs, headless Blender builders, manifest, Vite watch, CI; player bike now loads from `racer.glb` | ✅ |
| M9.28 | Trimesh tunneling fix — CCD on bike rigid body + 1m slab-extruded spec track surfaces (replaces 0-thickness planes); `build_track.py` now also emits `public/tracks/<id>.json` with start yaw + spline anchors so `pnpm gen:tracks` produces a fully playable track in one step | ✅ |
| M9.38 | Planar water reflection — TSL `reflector()` node mirrors scene onto water with wave-normal-distorted UV, Fresnel-mixed into base color | ✅ |
| M9.39 | Bike pipeline flip — one `bikes-src/<id>.blend` per variant (no shared kit, no propagation), Blender addon's *Export Bike to Game* writes GLB + starter spec JSON, addon panel auto-detects bike vs track mode by parent dir, headless `pnpm gen:bikes` opens each .blend and applies spec recolour overlays | ✅ |
| M9.40 | Feel pass — lean limit bumped to ~20° with two-stage speed curve (lays over to ~30° at top speed), slope-projected gravity along bike forward (wave-down accelerates / wave-up decelerates), mobile virtual joystick Y inverted to match gamepad/flight-stick convention | ✅ |
| M9.41 | Lean crank — `ROLL_LEAN_LIMIT` doubled to 40°, so the high-speed boost reaches ~60° at top speed (was ~30°). Bike now visibly lays over through the apex. | ✅ |
| M9.42 | Authoring-tools cluster — placement helper (curve-constrained empty + one-click drops), downtown generator (block-aligned plinth with sidewalk/road two-material grid + per-building terrain-conform skirts), tunnel tool (Bezier curve → boolean cutter + interior shell, terrain modifier baked at export). SOTA terrain coloration pass (domain-warped noise, triplanar cliffs, scree band, stochastic altitude jitter). Two reference templates: `template-downtown.blend`, `template-tunnel-island.blend`. Latent fixes: terrain shader detection narrowed (was clobbering every kind=track mesh), `derive_track_json` now writes real checkpoint quaternions from `rotation_euler.z` (was hardcoded identity). | ✅ |
| M10.1 | PRNG determinism — seeded mulberry32, two SimWorld with same seed produce same sequence | ✅ |
| M10.2 | Determinism harness — `?determinism=1` gates the RAF loop; Playwright probe runs `simulateStep` direct and snapshots Rapier state for cross-load comparison | ✅ |
| M10.4 | InputFrame wire format (10-byte LE record: tick u32, peerId u8, flags u8, throttle/steer/pitch i8/127, brake u8/255). First PartyKit relay room (`party/relay.ts`): peer-slot assignment, JSON control messages, binary frame broadcast. Opt-in via `?room=<id>` | ✅ |
| M10.5 | Per-peer `simulateStep` — `StepInputs.peerInputs: Map<peerId, Intent>`. New `PeerControlled { peerId }` component on bikes; `applyPeerInputs` dispatches each peer's intent to the matching bike. PlayerTag retained for camera / HUD / replay. | ✅ |
| M10.6 | Remote-intent drain — NetRoom buffers last-known Intent per remote peerId and exposes it for the sim loop to read each fixed step | ✅ |
| M10.7 | Remote-peer bike spawn — `peer-joined` spawns a PeerControlled bike at a grid offset (default racer variant); `peer-left` despawns (removes rigid body + entity). Bike automatically receives relayed inputs via M10.5/M10.6. | ✅ |
| M10.8 | Remote bikes tagged `Racer` so the local race system tracks their checkpoint crossings, lap, finish state, and surfaces them in the position HUD ("pos N/M"). Each peer computes standings against its own local sim — views may drift by network latency until shared race state lands. | ✅ |
| M10.9 | Room HUD chip (`#hud-room`) showing room id + your peer slot + remote peers. Deterministic peer-id → livery colour so a reconnecting peer keeps the same accent. | ✅ |
| M10.10 | Deployed PartyKit endpoint. Client `netHost` default flips on `import.meta.env.DEV`: dev → `localhost:1999`, prod → `hoverbike.occ-matt.partykit.dev`. `?host=<h>` still overrides either way. Vercel build + `pnpm party:deploy` now reach the same relay so two tabs on the live URL share a room without any flags. | ✅ |
| M10.11–.12 | Owner-authoritative transform snapshots (20 Hz) + lobby with ready states / smash-bros pick / sticky raceStarted bit for late joiners. | ✅ |
| M10.x (Multiplayer convention row) | Settings → Network tab + 1 Hz ping/pong latency display + mp-status pub/sub. See [v1-work-breakdown.md § Multiplayer](./v1-work-breakdown.md). | ✅ |
| v1 Step 0 | Menu cathedral — full mode/cup/track/bike/settings flow with disabled-state convention. PR #110 | ✅ |
| v1 Step 1 | Foundation Systems (5/5): wave-pump signal, AI difficulty + rubber-band, anti-grav HUD + camera, tutorial framework, audio mixer + music bed. | ✅ |
| v1 Step 2 | Reef Cup tracks (Sandbar / South Beach / Hatteras / Cape Town) build + export end-to-end. | ✅ |
| v1 Step 3 | Open Sea + Continental Cup tracks (The Maw / Shibuya / Kilauea / Marina Bay / Doge's) build + export end-to-end. | ✅ |
| v1 Step 4 | Drowned Cup tracks (Aqualand / Angkor Drowned / Liberty Drowned) build + export end-to-end. **v1 lineup complete: 12/12 ship.** | ✅ |
| v1 Step 6 | Time Trial + ghost recording, Cup wiring (Dev Placeholder + four ship cups), Leaderboard local + global (HMAC-signed PartyKit Party + moderation CLI). | ✅ |
| v1 Step 7 | Multiplayer room codes + lobby + 8-bike stability (state sync polish ongoing). | ✅ |
| v1 Step 8 (Polish/QA) | Perf HUD + perf-recorder, Accessibility tab (8 rows lit), cross-browser Playwright projects, Steam Deck profile + Electron desktop wrapper (Linux tree + Windows NSIS, real WebGPU on Deck), mobile MENU button + touch HUD, water/underwater polish, QA tooling (`pnpm qa` orchestrator + matrix + soak + bug-bundle + playbook). Perf-budget pass against the 60 fps / 8-bike target still pending. | 🟡 |
| v1 Drift mini-turbo | MK-style mini-turbo (MT/SMT/UMT tiers) + inside-drift archetypes + colored sparks + skid audio + HUD tier badge + AI drift + DRIFT tutorial beat + Drift Practice Range. See [drift-deep-dive.md](./drift-deep-dive.md). | ✅ |
| v1 Surface registry | Per-collider lateral grip (`SurfaceType` — default / asphalt / metal 1.25× / sand 0.70× / ice 0.35× / water). Blender authoring UI is the remaining follow-up. | 🟡 |
| v1 Tricks rework | Geometric pop-based trick window (replaces vy gate) — fires off lips / ramp crests / ledges / embankments via per-end contact flags. Pre-press buffer (200 ms) holds presses mid-climb. | ✅ |
| v1 Tuck sweet-spot | Snowboarder nose-down sweet spot folded into the existing pitch-down gesture — meter + slipstream VFX + per-bike `tuckSpeedBoost` / `tuckDragMul`. | ✅ |
| v1 Hover polish | Dive kick + release kick, bow/stern spring curves, no-PD-in-air revert, climb-assist gated on forward throttle, yaw-coupling fix (`20a5547`). | ✅ |
| v1 Water LOD | Center mesh doubled (inner + outer LOD) + cross-fade + Gerstner skirt + reflection fixes (shared planar-reflection RT, 500 m fade, fresnel-sky tint at grazing, haze cap reconciled with fresnel). | ✅ |
| v1 Electron port | Replaces Tauri/WebKitGTK for the Steam Deck + Windows depot. Real WebGPU inside the Steam Linux Runtime; Linux Steam depot dropped (Proton handles the Deck). | ✅ |
| v1 Making-of microsite | Six chapters with real-sim-importing playable Three.js demos. Linked from main menu. | ✅ |

## File / system map

```
src/
├── main.ts                       # boot + per-frame loop + key bindings + URL params
├── debug.ts                      # window.__hover dev API
├── engine/
│   ├── audio/audio.ts            # procedural Web Audio engine + ambient + SFX
│   ├── garage.ts                 # DOM overlay: bike + track picker, best-lap viewer
│   ├── save-state.ts             # localStorage best-lap persistence
│   ├── sim/                      # NO Three.js imports
│   │   ├── ecs/                  # bitECS world + side-table stores
│   │   ├── physics/              # Rapier wrapper + vec/quat utils
│   │   └── water/                # Gerstner wave field + analytic normal sampler
│   ├── render/                   # Three.js layer
│   │   ├── glb-track.ts          # GLTFLoader + attachTrackColliders (calibration scene render)
│   │   ├── renderer.ts           # WebGPU/WebGL2 detect
│   │   ├── camera.ts             # chase cam with orbit
│   │   ├── scene.ts              # sky, lighting
│   │   ├── water.ts              # CPU-driven faceted water mesh
│   │   ├── sky.ts                # gradient sky dome
│   │   ├── direction-arrow.ts    # 3D Crazy-Taxi arrow with shaded material
│   │   ├── track-mesh.ts         # gates + beacons
│   │   ├── arena-mesh.ts         # Lagoon Loop's infield island
│   │   ├── ramp-mesh.ts          # Lagoon Loop's chevron jump ramp
│   │   ├── cliffside-mesh.ts     # Cliffside's mesa + climb ramp + cliff face
│   │   ├── bike-mesh.ts          # bike body, fin, tail light, hover puck
│   │   ├── pickup-mesh.ts        # rotating glowing crate (per-type colored)
│   │   ├── pickup-render.ts
│   │   ├── combat-render.ts      # mines, missiles, shield bubbles, explosions
│   │   └── render-systems.ts     # ECS → Three.js bike sync (livery + exhaust glow tints)
│   └── input/
│       ├── intent.ts             # Intent type
│       ├── keyboard.ts           # smoothed WASD/arrows + Q/E
│       ├── gamepad.ts            # standard mapping
│       ├── touch.ts              # virtual stick (no on-screen overlay yet)
│       ├── camera-look.ts        # mouse drag + right stick orbit
│       └── index.ts              # merge keyboard + gamepad + touch
├── game/
│   ├── components/               # bitECS tags + side-table data types
│   │   ├── index.ts              # Transform, BikeStats, ControlIntent, HoverState…
│   │   ├── ai.ts                 # AIController state
│   │   ├── pickup.ts             # PickupSpawn, PickupSlot, BoostEffect
│   │   ├── combat.ts             # ShieldEffect, Stun, MineState, MissileState, ExplosionState
│   │   └── race.ts               # Racer (lap, nextCheckpoint, raceTime)
│   ├── systems/                  # all sim-side ticking logic
│   │   ├── hover.ts              # ride-height + thrust + steer + kinematic pitch/roll
│   │   ├── input-apply.ts        # player Intent → ControlIntent
│   │   ├── ai-control.ts         # spline follower with PD steering
│   │   ├── ai-combat.ts          # decides when AI fires its held pickup (pure shouldAIFire)
│   │   ├── rubber-band.ts        # AI top-speed adjusts to leader gap
│   │   ├── race.ts               # checkpoint crossing detection + lap count
│   │   ├── pickup.ts             # collect/use system, boost effect
│   │   ├── combat.ts             # mines, missiles, hit reaction, stun, shield ticks
│   │   ├── standings.ts          # rank ordering
│   │   └── sync-from-physics.ts
│   ├── entities/                 # factories — physics + ECS wiring
│   │   ├── arena.ts              # safety floor + Lagoon Loop island
│   │   ├── ramp.ts               # Lagoon Loop's jump ramp
│   │   ├── cliffside-terrain.ts  # Cliffside's mesa + climb ramp (constants reused by mesh)
│   │   ├── bike.ts               # createBike with optional stats override
│   │   ├── pickup-spawn.ts       # POOL of pickup types (boost-weighted)
│   │   ├── mine.ts / missile.ts / explosion.ts  # one-shot combat entities
│   ├── tracks/                   # Track type + procedural track configs
│   │   ├── types.ts
│   │   ├── spline-utils.ts       # buildStadiumAISpline — smooth tangent-arc through curves
│   │   ├── glb-loader.ts         # parse .glb JSON → Track (Three-free; loader for ?track=calibration)
│   │   ├── lagoon-loop.ts        # default stadium track
│   │   └── cliffside.ts          # mesa + cliff drop, also the Blender-export reference
│   └── bikes/                    # stats + variants
│       ├── stats.ts              # defaultBikeStats
│       └── variants.ts           # cruiser / racer / stunt archetypes
└── ui/                           # (empty — HUD lives in index.html)
tools/                            # Blender Python scripts (pipeline scaffold; not run end-to-end yet)
tests/
├── unit/                         # Vitest, sim only (49 tests)
└── e2e/                          # Playwright via real Vite server (25 tests)
```

The tree above is the M9-era shape; the v1 push added several leaves that are worth
calling out because newcomers grep for them:

```
src/
├── boot/                         # boot-time wiring (split out from main.ts)
│   ├── game-loop.ts              # the rAF loop + finish-overlay branching
│   ├── controls.ts               # action installation (pause / restart / menu gamepad)
│   ├── multiplayer.ts            # MP HUD chip + room wiring
│   ├── rider-editor-mode.ts      # `?rideredit=1` rider customization scene
│   ├── wave-rider-mode.ts        # `?waveriders=1` floating-prop validation
│   └── url-modes.ts              # URL param → boot mode dispatch
├── engine/
│   ├── sim/
│   │   └── surface-types.ts      # per-collider lateral-grip registry
│   ├── render/
│   │   ├── perf-hud.ts           # backend + GPU + Deck-profile diagnostics
│   │   ├── water-coverage.ts     # LOD mesh + cross-fade
│   │   ├── drift-tier-hud.ts     # MT / SMT / UMT badge
│   │   ├── tuck-hud.ts           # nose-down sweet-spot meter
│   │   ├── wave-line-shimmer.ts  # forward-fan crest predictor (3D)
│   │   ├── wave-line-hud.ts      # WAVE LINE pip
│   │   ├── anti-grav-hud.ts      # magenta-glow indicator
│   │   ├── wave-pump-hud.ts      # post-pump chyron + strength bar
│   │   ├── tutorial-hud.ts       # track-agnostic chyron
│   │   ├── cup-results-screen.ts # championship summary overlay
│   │   ├── rider-appearance.ts   # primitive-shape rider (editor-driven)
│   │   ├── rider-mesh.ts
│   │   ├── leaderboard-finish-banner.ts
│   │   └── fx/index.ts           # particle pools — sparks, splashes, tuck slipstream
│   ├── tutorial/                 # director + script + launch URL builder
│   ├── replay/                   # pose recorder + ghost slice + ghost persistence
│   ├── net/                      # PartyKit relay client + mp-status pub/sub + latency
│   ├── qa/                       # console-trap + bug-bundle helpers (__hover.qa)
│   ├── accessibility/            # palettes + DOM bridge + service pub/sub
│   ├── leaderboard/              # signed PartyKit Party client + profanity filter
│   ├── audio/audio.ts            # four-bus mixer (master/music/sfx/ambient) + procedural bed
│   ├── audio/audio-service.ts    # singleton bridge to settings overlay
│   ├── tutorial/                 # director + 6-beat default + DRIFT beat
│   ├── menus/                    # mode-flow + settings overlay + rebind modal + MP lobby
│   ├── input/
│   │   ├── bindings.ts           # action set + swap-on-rebind semantics
│   │   ├── menu-gamepad.ts       # one-poller convention + isAnyOverlayShown
│   │   └── deck-glyphs.ts        # standard / deck / ps / switch glyph tables
│   ├── steam-deck.ts             # Deck detection + profile application
│   ├── player-settings.ts        # player-facing tunable inventory (v2 blob)
│   ├── cup-progress.ts           # sessionStorage cup state + MK8 points
│   └── wave-pump-observer.ts     # crest-launch detector (render side)
├── game/
│   ├── components/
│   │   ├── wave-rider.ts         # WaveRiderTag (floating prop)
│   │   ├── trick.ts              # TrickState (window arming)
│   │   ├── drift.ts              # DriftState (dir + charge time + tier)
│   │   ├── tuck.ts               # TuckState (scrape lockout)
│   │   ├── rider-pose.ts         # RiderPose (per-bone targets)
│   │   └── …                     # plus the M9-era components
│   ├── systems/
│   │   ├── drift.ts              # MK-style mini-turbo (charge / release / cancel)
│   │   ├── drift-tiers.ts        # pure leaf — thresholds + multipliers (also imported by /making-of/drift)
│   │   ├── trick-hop.ts          # geometric pop-based window
│   │   ├── tuck-curve.ts         # pure leaf — sweet-spot curve (also imported by /making-of/feel)
│   │   ├── ghost-runner.ts       # ghost Transform driven by player lap-time
│   │   ├── rider-pose.ts         # IK pose blend + drift lean target
│   │   ├── rider-crash.ts        # ragdoll on hit-reaction
│   │   ├── wave-rider.ts         # pose-drive + collision tag
│   │   ├── boost-meter.ts        # accumulator + decay
│   │   ├── boost-pad.ts          # author-placed strength multipliers
│   │   ├── anti-grav.ts          # weight blending + override
│   │   ├── remote-interp.ts      # 20 Hz snapshot smoothing
│   │   ├── apply-snapshot.ts     # owner-authoritative transform sync
│   │   └── wake-update.ts        # per-bike wake source emission
│   ├── ai/
│   │   ├── difficulty.ts         # Casual / Standard / Hard tuning bundle (+ drift + pump)
│   │   └── pump-hints.ts         # spline ⨯ wave-zone derived AI pump beats
│   ├── entities/
│   │   └── wave-rider.ts         # buoy + log archetypes
│   └── sim-step.ts               # ordered system list (single source of truth)
├── viewer/                       # bike viewer scene (`?viewer=<id>`)
└── debug.ts                      # window.__hover dev API (now: bikes, net, qa, …)

making-of/                        # six-chapter microsite (Vite multi-page)
├── wave-field/   buoyancy/   feel/   drift/   sim-render/   steam/

electron/                         # desktop wrapper (replaces Tauri)
├── main.cjs                      # GPU flags + Steam Linux Runtime workarounds
├── hoverbike-launch.sh           # Steam Deck launch wrapper
└── icons/                        # placeholder teal icons (gen:icons)

party/                            # PartyKit Parties
├── relay.ts                      # InputFrame + TransformSnapshot relay (8 peers)
└── leaderboard.ts                # signed-submit + admin / moderation
```

The unit-test count is now well into the 800s and the e2e suite carries the
QA matrix + soak gates; see [`docs/qa-playbook.md`](./qa-playbook.md) for the
breakdown.

## Important conventions

These are the load-bearing decisions that future work needs to respect.

1. **Sim layer cannot import Three.js.** Anything under `src/engine/sim/` or `src/game/systems/` must be Three-free. Render systems read from the ECS world and write to Three.js objects, never the other way. Keeps headless tests + future multiplayer rollback netcode possible.

2. **bitECS 0.4 components are tags only — data lives in side-table stores.** See `engine/sim/ecs/store.ts`. The component itself (e.g. `Transform`) is a unique object reference used for queries. The data (`TransformData`) lives in `TransformStore` keyed by entity id. This was a refactor after M0 because bitECS 0.4 doesn't store data on components without observable hooks.

3. **Sign conventions in `hover.ts` are empirical, NOT standard math.** Yaw torque is `-intent.steer * turnTorque` around **world Y** (M9.4 reverted M9.3's bike-local-up choice — see `feedback_hoverbike_conventions.md`). Lean roll target is `+intent.steer * LIMIT * speedScale` (positive coefficient — the chase-cam mirroring inverts what the math would predict, M9.5b). Pitch and roll are **kinematic** in YXZ Euler decomposition; only yaw evolves from physics torques. Don't change any sign without playtesting on real hardware.

4. **Debug API is the testing surface.** `window.__hover` exposes `player()`, `race()`, `bikes()`, `setIntentOverride()`, `toggleAutoPlay()`, etc. This is how Playwright tests drive the game and how Claude inspects state. Keep it consistent with new features.

5. **Player and AI share the same `ControlIntent` plumbing.** Auto-play mode just adds `AITag` to the player so `aiControlSystem` writes their intent. Player intent path (`applyPlayerIntent`) is suppressed while auto-play is on. Don't fork these paths.

6. **Coordinate convention.** +Z is forward, +Y is up, +X is right of a forward-facing bike. The bike's mesh has a yellow fin pointing +Z (forward) and a red tail light at -Z (back) — visual cue that matches the physics.

## How to develop

```bash
pnpm install
pnpm dev              # http://localhost:5191 (auto-falls-through to 5192+ if taken)
pnpm test             # vitest unit
pnpm e2e              # playwright (4 workers, real WebGPU/WebGL2)
pnpm typecheck
pnpm exec biome check --write .   # format + lint
```

## Picking this up in a fresh Claude session

The conventions, bugs, and gotchas above are the load-bearing context. Some specific tips:

- The `window.__hover` debug API + the Claude Preview MCP (`preview_eval`, `preview_screenshot`) are how to inspect runtime state. Use them eagerly. The browser preview tab is often *hidden* during a session — `requestAnimationFrame` doesn't tick when hidden, so use a Playwright probe spec for any test that needs the sim to actually advance.
- E2E tests double as integration tests. When changing physics or input, run `pnpm e2e` rather than just typechecking.
- The `tests/e2e/m6-autoplay.spec.ts` test prints the player trajectory — invaluable for debugging AI behaviour and physics edge cases. Several other specs follow the same "drive a scenario then dump samples" pattern (see `m9-ramp.spec.ts` for the canonical example).
- URL params: `?track=lagoon|cliffside` and `?bike=cruiser|racer|stunt`. Defaults are `lagoon` + `racer`. Players also reach these via the GARAGE button.
- Vercel auto-deploys on push to `main`. There is no preview-deploy gate, so don't push half-broken code.
- The user (matt / occ-matt) prefers tight, focused commits with explicit "why" in the message. Co-author tag is `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- The user is OK with auto mode pushing through routine tasks but wants to be the empirical source of truth on "feel" — playtest reports trump my analysis.
