# Wave zones cookbook

In-depth recipes for the **wave-zone** authoring tool. Drop a
`wave_zone_NN` empty, tune its custom properties, ship a track
where the water is part of the racing instead of background fill.

This page assumes you've already read [Your first track](./your-first-track)
and have a `.blend` open with `water_volume_main` placed. For the
operator reference see [Addon reference → Wave zones](./addon-reference#wave-zones);
for the kind matrix see [Scene conventions](./scene-conventions).

## What wave zones do

The runtime samples the wave field at every surface query
(buoyancy, the wave-pump system, the renderer's displaced plane).
Each sample point checks the world-XZ projection against every
`wave_zone_NN` empty's oriented bounding box and blends per-zone
factors on top of the global Gerstner field:

- `heightMult` scales every base wave amplitude.
- `freqMult` scales every wave frequency (`= 1/wavelength`) —
  bigger means shorter wavelengths (choppier); smaller means
  longer rolling swells.
- `directionDeg` (optional) overrides the dominant swell bearing
  inside the zone — useful for rotating a swell to crash into a
  specific turn.
- `surgePeriod_s` + `surgeAmplitude` (optional, both-or-nothing)
  add `surgeAmplitude · max(0, sin(2π·t / surgePeriod_s))` to the
  zone's sampled height — a half-rectified sine that lifts the
  whole water surface every period, then drops back to 0. Designed
  for set-piece tsunami timers.
- `blendRadiusM` smooths the OBB edge so the boundary is
  invisible at the racer's altitude (default 20 m is a good start).

Overlap rule: a **soft-max** on multipliers (the strongest-weighted
zone wins on `heightMult` / `freqMult` / `directionDeg`) plus
**additive** surges (two surge sources sum, so "two tsunamis
meeting" reads as a bigger wave). Sampling math lives in
`sampleZoneFactors` in `src/engine/sim/water/wave-field.ts`.

## When to reach for a wave zone

| You want… | Solution |
|---|---|
| Bigger / smaller waves only in one stretch | Single zone, `heightMult` ≠ 1, `freqMult = 1` |
| Choppier surface in a harbour mouth | `heightMult` ~ 1, `freqMult > 1` |
| Long rolling ocean swell in one bay | `heightMult > 1`, `freqMult < 1` |
| Periodic tsunami sweeping a stretch | `surgePeriod_s` + `surgeAmplitude` together |
| Swell crashing into a specific turn | `directionDeg` set to the desired bearing |
| Calm harbour inside a stormy ambient field | `heightMult < 1` in the calm area |
| Global storm intensity | **Don't** use a zone — set `sky.seaStateBeaufort` instead |

::: tip Set the ambient first
Global wave amplitude is driven by `sky.seaStateBeaufort` (0..12
on the Beaufort scale; default ≈ 4). Set that first to the
**typical** sea state for the track, then use wave zones for
**local** deviations. A Beaufort-7 storm track with a Beaufort-1
calm harbour reads as more dramatic than a Beaufort-4 track with a
huge zone everywhere.
:::

## Recipe 1 — Aqualand tsunami timer

The pattern from `public/tracks/aqualand.json`: a slow,
periodically-rising wave wall in the final straight that times
itself to threaten incoming racers. The classic "wave race" risk /
reward.

1. **Hoverbike sidebar → Wave zones → Add Wave Zone.** Drop at the
   3D cursor (move it to the section of track you want to hit).
2. **Size it to the racing-line band.** Open Object Properties →
   Custom Properties and edit:
   - `half_width = 50` (m along local +X — the swell axis)
   - `half_depth = 60` (m along local +Y)
   - `half_height = 30` (vertical extent — mostly cosmetic, leave
     it generous)
3. **Set the surge.** Add two new custom properties:
   - `surge_period_s = 30` (one big wave every 30 s)
   - `surge_amplitude = 4` (4 m extra height at the peak)
4. **Make the base bigger too.** Edit the auto-set defaults:
   - `height_mult = 2.5` (heavier base waves inside the zone)
   - `freq_mult = 0.8` (longer rolling wavelengths for the
     "approaching swell" feel)
5. **Soften the edge.** `blend_radius_m = 20` keeps the boundary
   invisible.
6. **Aim the swell.** Rotate around Z so local +X points along the
   intended swell direction (use Blender's R Z 90 etc, or just
   drag the rotation gizmo).

The exported JSON entry looks like this:

```jsonc
{
  "position": { "x": 20, "y": 0, "z": 65 },
  "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
  "halfWidth": 50,
  "halfHeight": 30,
  "halfDepth": 60,
  "heightMult": 2.5,
  "freqMult": 0.8,
  "blendRadiusM": 20,
  "surgePeriodS": 30,
  "surgeAmplitude": 4
}
```

Runtime behaviour: `max(0, sin(2π·t / 30))` lifts the surface by up
to 4 m every 30 s, on top of the 2.5× amplified base waves. At
period boundaries the surface drops to baseline and the wall
resets — racers time their pass to catch the trough.

::: warning Surge fields are both-or-nothing
The validator rejects an export where only `surge_period_s` is set
without `surge_amplitude` (or vice versa). The fields are paired
because either alone is meaningless and the runtime can't infer a
sensible default for the missing one.
:::

## Recipe 2 — Cape Town swell at a turn

The pattern from `public/tracks/cape-town-drift.json`. The Atlantic
swell rolls in from one direction; you want it to crash into the
outside line of the famous left-hander so the inside line is
calmer and the outside line is riskier-but-faster.

1. Drop the zone, size it to cover the turn's outside line + a
   blend-radius margin:
   - `half_width = 80` (long along the swell axis so the swell
     reads as a continuous train)
   - `half_depth = 40` (narrow enough that the inside line stays
     mostly outside the zone)
   - `half_height = 25`
2. Tune for **bigger but not faster** waves:
   - `height_mult = 1.8`
   - `freq_mult = 0.9` (slightly longer wavelengths — rolling, not
     choppy)
   - `blend_radius_m = 25` (more soft falloff so the inside-line
     racer feels the swell coming, not a hard edge)
3. **Force the swell direction.** Add `direction_deg` as a custom
   property. The world-XZ bearing here is "from the south-west":
   - `direction_deg = 225` (south-west swell crashing into a
     north-east-facing apex)
4. Rotate the empty so local +X also faces that bearing — strictly
   `direction_deg` overrides the bearing for amplitude / phase
   purposes, but aligning the zone's local +X with the swell makes
   the OBB obvious in the viewport and the gizmo arrow point the
   right way.

When `direction_deg` is unset the zone inherits the global
`waveBearing`. When set, samples inside this zone use the override
instead. Samples outside the zone are unaffected, so the rest of
the bay still reads the global bearing. Where two zones with
different `direction_deg` overlap, the soft-max winner picks one —
useful for nesting (a "regional" zone covering the bay + a tighter
"local" zone over the apex that takes over), less so for true
"crashing swells". For visibly crashing swells, prefer **non-
overlapping** zones with adjacent OBBs aimed at each other.

## Recipe 3 — Marina Bay 7 harbour calm

The pattern from `public/tracks/marina-bay-7.json`. Outside the
harbour the Singapore Strait is choppy; inside the protected
basin around the start / finish straight the water should be
glass-flat for a clean overtake window.

1. Set the ambient stormy: `sky.seaStateBeaufort = 6` in the
   **Sky preset** sub-panel.
2. Drop a wave zone over the protected basin:
   - `half_width = 90`
   - `half_depth = 60`
   - `half_height = 20`
3. Make it **dampening**:
   - `height_mult = 0.2` (waves shrink to 20% of ambient — visible
     ripples remain but the surface reads flat)
   - `freq_mult = 1.0` (no wavelength change — just smaller)
   - `blend_radius_m = 30` (long blend so the storm-vs-calm
     transition is gradual, matching the breakwater silhouette)
4. No `direction_deg`, no surge — calm zones rarely need either.

Authors often layer a second, larger zone with
`height_mult = 0.5` just outside this one so the storm "calms
down" twice as you approach the harbour mouth — soft-max picks
the loudest (most damped) zone at each point, so the gradient
reads naturally.

## Recipe 4 — Choppy harbour mouth

The pattern around the harbour entrance on Doge's Drift. You want
the wave amplitude similar to ambient but the surface noticeably
choppier so the bike's hover skirt bucks.

```jsonc
{
  "halfWidth": 60,
  "halfHeight": 20,
  "halfDepth": 30,
  "heightMult": 0.3,
  "freqMult": 1.5,
  "blendRadiusM": 12
}
```

`height_mult < 1` makes the absolute amplitudes smaller, but
`freq_mult = 1.5` shortens wavelengths so the surface bucks
more frequently — the bike "rattles" through the chop rather than
"rolling" through swell. Pair with a smaller `blend_radius_m`
(12 instead of 20) so the chop has a noticeable edge — racers
should feel the chop kick in rather than gradually rising.

## Recipe 5 — Nested regional + local swell

Use **a wide outer zone + a tighter inner zone** to model "the
whole bay has rolling swell, but the inside line of the apex is
also choppy". This is how soft-max works in your favour: the
inner zone has higher per-sample weight (the racer is closer to
its OBB centre) so it dominates inside, while the outer zone
takes over once the racer drifts past the inner zone's blend
falloff.

| Zone | `half_*` | `heightMult` | `freqMult` | `direction_deg` | What it does |
|---|---|---|---|---|---|
| 0 (outer) | 200 × 200 × 30 | 2.0 | 0.7 | 180 (south) | Whole-bay rolling swell |
| 1 (inner) | 40 × 40 × 25 | 1.8 | 1.4 | 90 (east) | Apex-only chop |

Place zone 1 with its OBB centre on the apex; the racer hits the
inner zone's stronger weight there and reads the chop. Drift to
the outside line and zone 0's weight wins again — back to rolling
swell. The transition between the two is smooth because soft-max
uses a continuous weight function, not a hard step.

For **surges from multiple zones, behaviour is different**:
surges accumulate (additive), so an Aqualand-style timer plus a
secondary "background pulse" gives a richer interplay rather than
the loudest one masking the other.

## Recipe 6 — Calibration-style "everything at once"

For testing or for showcase tracks, you can stack zones to test
all the controls at once:

```jsonc
{
  "waveZones": [
    { "halfWidth": 40, "halfHeight": 20, "halfDepth": 40,
      "heightMult": 2.0, "freqMult": 1.0, "blendRadiusM": 20 },
    { "halfWidth": 40, "halfHeight": 20, "halfDepth": 40,
      "heightMult": 0.3, "freqMult": 1.5, "blendRadiusM": 12 },
    { "halfWidth": 60, "halfHeight": 30, "halfDepth": 60,
      "heightMult": 1.5, "freqMult": 0.6, "blendRadiusM": 25,
      "surgePeriodS": 12, "surgeAmplitude": 3 },
    { "halfWidth": 30, "halfHeight": 20, "halfDepth": 30,
      "heightMult": 1.0, "freqMult": 1.0, "blendRadiusM": 10,
      "directionDeg": 135 }
  ]
}
```

This is a useful authoring fixture — drop these four zones in a
2×2 grid on a flat-water track and you can fly the chase camera
through each to feel what every knob does in isolation.

## Authoring loop

1. **Add the zone.** Hoverbike → Wave zones → **Add Wave Zone**.
2. **Position + rotate** in the viewport. The cyan box gizmo plus
   the arrow on its top face show the volume and the swell
   direction.
3. **Tune the extras** in Object Properties. If the gizmo doesn't
   resize to match a changed `half_*`, hit **Refresh Wave Zone
   Visuals** — the auto-refresh only fires for addon-managed
   sliders, not for Properties-panel edits.
4. **Export Track to Game.** The zone serialises into `waveZones[]`
   in the JSON. Refresh the browser tab — the runtime applies
   immediately, no code change needed.
5. **Iterate live.** Open `?track=<id>&edit=1` to scrub the runtime
   wave field in real time; the wave-zone values come from the
   JSON your Blender export wrote. The in-app editor cannot create
   wave zones (Blender owns them) but can scrub their effect.

## How to tell the runtime is honouring your zone

Open the dev-tools console while playing. The wave-field
initialisation logs each zone's `position`, `halfWidth`,
`heightMult`, `surgePeriodS` (if set). If your `.blend`'s zones
don't appear there, the export merge didn't pick them up —
double-check the empties are named `wave_zone_NN` (zero-padded),
have `kind = "wave_zone"`, and are visible in the outliner (the
exporter filters on `visible_get()`).

Once you see the zone in the log, fly the chase cam over it and
watch the wave-displaced plane. The amplitude / wavelength
should visibly differ inside the OBB; if `surge_*` is set, watch
for the periodic rise (one frame snapshot won't show it — let
several `surgePeriodS` cycles pass).

## Performance

Wave zones are cheap. The sample math is a per-zone
"point-in-OBB" plus a soft-max accumulator — O(zones × samples),
but `samples` is small (hundreds of buoyancy queries per frame, a
few thousand renderer vertices). A track with five wave zones
costs a few microseconds per frame on a modern CPU.

The renderer's wave-displaced plane re-evaluates every vertex, but
the per-vertex zone test is also a few flops. Don't worry about
zone count up to ~20 per track; beyond that the soft-max merge
will start to flatten interesting overlaps anyway.

## Common mistakes

- **Forgetting both `surge_*` fields together.** The validator
  rejects half-specs. If you only need one of the two, you don't
  need surge at all — set `height_mult` higher instead.
- **`blend_radius_m = 0`.** The zone becomes a hard cutoff and
  the OBB face is visible. Leave the default 20 m for invisible
  blending; lower for set-piece "wave wall" moments where the
  edge should read.
- **Using the zone for global storm intensity.** That's what
  `sky.seaStateBeaufort` is for. Wave zones layer **on top** of
  the global field; they're for **local** deviation.
- **`height_mult = 0`.** Zones with zero amplitude are valid
  (perfect calm) but a `height_mult` of 0.05–0.3 reads more
  naturally — visible ripples plus a flat-water "feel". Pair with
  `freq_mult` of 1.0–1.5 for a "small wavelets" calm.
- **Rotation matters for swell direction.** The empty's local +X
  is the dominant swell direction. Without `direction_deg` the
  rotation drives the swell train; with `direction_deg` set, the
  rotation only affects the gizmo and the OBB shape. If your zone
  isn't aimed where you expect, eyeball the top-face arrow.

## Reference scenes

| Scene | Where to look |
|---|---|
| `tracks-src/aqualand.blend` | Tsunami timer wave zone — open and select the empty to see the `surge_*` extras live. |
| `tracks-src/marina-bay-7.blend` | Two calm zones layered for harbour-protection gradient. |
| `tracks-src/cape-town-drift.blend` | Swell-into-turn zone with `direction_deg` override. |
| `tracks-src/the-maw.blend` | Multiple zones with competing swell trains across the central arch. |
| `public/tracks/*.json` `waveZones` arrays | Production examples — read the JSON for the exact final values. |

## See also

- [Addon reference → Wave zones](./addon-reference#wave-zones) — operator + property table.
- [Scene conventions → Custom properties](./scene-conventions#custom-properties-reference) — full `wave_zone` extras schema.
- `src/engine/sim/water/wave-field.ts` — runtime evaluator (`sampleZoneFactors`).
- `src/game/tracks/types.ts` — `WaveZone` type docstring.
- `tools/blender/hoverbike_addon/wave_zone.py` — addon source.
