# Hoverbike — Project Status

> Last updated: 2026-05-09 (M9.41 lean crank — `ROLL_LEAN_LIMIT` doubled from 20° to 40°, so the high-speed boost takes the bike to ~60° at top speed (was ~30° in M9.40); the bike now visibly puts a knee down through the apex. M9.40 feel pass — slope momentum projects gravity along the bike's forward axis so coasting down a wave's leeward face accelerates and climbing the windward face decelerates; mobile virtual-joystick Y is inverted to match the gamepad/flight-stick convention (stick up = nose-down dive). M9.39 bike pipeline flip — every variant is now a standalone `bikes-src/<id>.blend` (no more shared kit + propagation). Author the bike directly, click *Hoverbike → Export Bike to Game* in the addon, GLB updates and the runtime picks it up on next reload.). Live build: https://hoverbike-ciaqaossl-oddballcreatureclubs-projects.vercel.app — every push to `main` auto-deploys.

This doc captures the build's current state, controls, known issues, and next steps. It complements [product-plan.md](./product-plan.md) (vision + MVP scope) and [implementation-plan.md](./implementation-plan.md) (architecture + milestone breakdown).

## What works today

- Two tracks: **Lagoon Loop** (default; jump ramp on the right straight) and **Cliffside** (`?track=cliffside`; mesa with cliff drop, doubles as the Blender-export reference layout)
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
- Race lap counting with finish overlay
- Direction arrow (Crazy Taxi style) above the player pointing to the next checkpoint
- Sky beacon over the next gate
- Auto-play mode (T or F1) — AI takes over the player bike for testing
- Backspace = respawn at start
- Mouse right-drag and gamepad right-stick orbit the camera (vertical inverted by default)
- 27 e2e + 55 unit tests, all green
- Spec → GLB asset pipeline (M9.27, flipped to per-variant in M9.39): `specs/{bikes,props,tracks}/*.json` + `tools/blender/build_*.py` produce `public/assets/<cat>/*.glb` and `public/assets/manifest.json` via `pnpm gen:all`. Bike-loader instantiates the player + AI bike GLBs at boot; prop-loader pre-fetches asset-prop GLBs referenced by track JSON. **Bikes:** one `bikes-src/<id>.blend` per variant — open it in Blender, edit the variant directly (no shared kit, no propagation), click *Hoverbike → Export Bike to Game*, the GLB updates and the runtime picks it up on next reload. The same addon serves tracks via *Export Track to Game* and switches mode based on the .blend's parent dir. Headless `pnpm gen:bikes` opens each .blend, overlays spec.appearance recolour + spec.physics extras, exports. **Tracks:** spec-driven `build_track.py` round-trips through `tracks-src/<id>.blend` and emits both the GLB and a starter gameplay JSON. **Bike viewer** (`?viewer=<bikeId>` or the addon's *Copy Viewer URL*) opens a turntable with OrbitControls, sockets/colliders surfaced as gizmos.
- Vercel push-to-deploy, Cloudflare CDN ready (not yet attached to a domain)

## Controls

### Keyboard
| Key | Action |
|---|---|
| W / ↑ | Throttle forward |
| S / ↓ | Brake / reverse |
| A / ← | Steer left |
| D / → | Steer right |
| Q | Pitch up (lean back, jump off a wave) |
| E | Pitch down (lean forward, dive into a wave) |
| Space | Fire pickup |
| Shift | Boost |
| Backspace | Respawn at start (snaps to spawn pose, zero velocity) |
| T or F1 | Toggle auto-play (AI drives player bike) |
| M | Toggle audio mute |
| R | Restart race after finish |

All keyboard axes are smoothed (~0.13s ramp) so taps give small inputs and holds give full deflection.

### Gamepad (Xbox / PS layout)
| Input | Action |
|---|---|
| Left stick X | Steer |
| Left stick Y | Pitch (push forward = dive, pull back = jump) |
| Right trigger | Throttle |
| Left trigger | Brake / reverse |
| Right stick | Camera orbit (Y inverted) |
| A / X (button 0) | Fire |
| B / Circle (button 1) | Boost |

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
