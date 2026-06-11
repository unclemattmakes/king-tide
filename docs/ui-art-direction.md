# UI art direction — "Regatta" (painted race-day signage)

> The UI/UX layer of the art direction. Where [art-direction.md](./art-direction.md)
> governs the world (painterly-vinyl, built/broken/blooming, warm sun on cold
> water), this doc governs **every pixel of chrome drawn over it**: the race
> HUD, the menus, the overlays, the type, the motion, and the voice.
>
> **This doc is canonical for:** UI palette tokens, typography, shape/motion
> language, the race-HUD inventory + layout, menu voice, and the UI roadmap.
> **It defers to:** [art-direction.md](./art-direction.md) for the world
> register it samples from, and the **input-navigability convention** in
> [v1-work-breakdown.md](./v1-work-breakdown.md) (unchanged, still law).
>
> Implementation lives in `index.html` (the single style block — tokens at the
> top), `src/engine/render/race-hud.ts` (HUD + minimap canvas), and
> `src/engine/branding.ts` (the product name, one place).
> Verify any change by eye: `E2E_PORT=<N> pnpm gen:ui-shots <label>` →
> `artifacts/ui-shots/<label>/`.

---

## The call — and why

Two concept directions were on the table: **neon holo-broadcast** (Wipeout-style
cyan line-art, speedo dials, glow everywhere) and **painted race-day signage**
(chunky painted badges, ribbon bars, postcard panels). The call is **painted
signage — "Regatta."**

The reasoning is the art bible itself. The world is a hand-painted vinyl toy:
warm sun on cold water, no outlines, glow reserved for living/powered things,
"a spectator sport during the collapse." Neon line-art chrome fails every one
of those tests — it's cold where the world is warm, drawn where the world is
painted, and it spends emissive (the world's survival signal) on dead UI
boxes. The old "sports broadcast" HUD looked out of place for exactly this
reason, and the neon concept is that same idea turned up, not fixed.

**The fiction stays — the material changes.** The Circuit *is* a show, so the
UI keeps broadcast jobs (lower thirds, standings, lap timers) but they're made
the way this world would make them: **painted boards, regatta bunting, enamel
badges, stenciled numbers.** Not "ESPN over the game" — "the race committee
painted the graphics package by hand."

One mind, one law: **the UI is a prop from the world.** If a panel couldn't
plausibly be painted plywood, an enamel pin, or a stitched flag somewhere in a
Circuit paddock, it doesn't ship.

## Principles (the non-negotiables)

1. **Same paint, same hands.** Every UI color is sampled from the world
   palette families in [art-direction.md](./art-direction.md). No hue that
   doesn't exist in the world. Panels are deep-water teal, content is warm
   cream — warm sun on cold water, repeated in miniature on every card.
2. **Signage, not interface.** Rounded painted boards with cream keylines,
   badge chips, ribbon headers. **Banned:** 1-px hairlines, glass blur panes,
   scanlines, holo-grids, gradient-stroke neon borders.
3. **Glow is a privilege — in the UI too.** Emissive mint (`#6CFFC8`) marks
   the *live* thing only: the focused control, GO!, a record falling, the
   "you're ahead" flash. At-rest chrome is matte paint. (This maps pillar 6 of
   the art direction onto interaction design: focus = powered.)
4. **Readable at 40 m/s.** One glance, one fact. Chunky display type for the
   six-foot read (position, lap, countdown), tabular numerals for anything
   that ticks, value contrast over decoration. If a widget needs study, it's
   wrong.
5. **Hierarchy by size, not by chrome.** The HUD's hero is the position
   ordinal; everything else steps down from it. New widgets must justify
   their glance-cost (see the inventory below — and the things we deliberately
   *don't* show).
6. **Everything navigable.** Keyboard + pad + touch on every interactive
   surface — the existing input-navigability convention, unchanged. Focus is
   the mint glow; it must be unmistakable on any background.

## Tokens

CSS custom properties in `index.html` `:root`. The `--bc-*` names are kept
(hundreds of usages; "bc" now reads "base chrome"); the *values* are Regatta.

| Token | Value | Role / world source |
|---|---|---|
| `--bc-ink` | `#FFF5E1` | warm cream — painted lettering ("built" cream `#F2E4C6`, lifted for contrast) |
| `--bc-ink-dim` | `#B9CEC4` | sea-mist — secondary copy |
| `--bc-ink-faint` | `rgba(255,245,225,0.55)` | tertiary / labels |
| `--bc-navy` | `#07222C` | deep-water board (cold side of the master contrast) |
| `--bc-navy-2` | `#0C3340` | lighter board / gradients |
| `--bc-cyan` | `#6CFFC8` | **the live/emissive signal** — focus rings, GO!, selected. Straight from Reef neon-mint. |
| `--bc-orange` | `#FF7A52` | coral sun — primary actions, the position badge, warm chips |
| `--bc-yellow` | `#FFD27A` | sun-gold — records, champion, "best" |
| `--bc-red` | `#FF5A6E` | hazard — danger text, "behind" deltas (filled hazard chips use Cape-Wheel `#E8503A`) |
| `--bc-green` | `#3DDC97` | sea-glass — success/ahead (mint's matte sibling) |
| `--bc-magenta` | `#FF46C8` | urban-neon pink — rare callouts (anti-grav, parked) |
| `--bc-line` / `--bc-line-strong` | cream @ 0.14 / 0.30 | painted keylines (thicker than v1's hairlines) |
| `--r-card` / `--r-chip` / `--r-pill` | `18px` / `12px` / `999px` | shape language — everything is rounded; sharp corners are banned |

**Surface recipe** (what makes a panel read painted, not glass): deep-water
fill (`--bc-navy` ~0.9 alpha), **2px cream keyline** at low alpha, `--r-card`
radius, soft drop shadow, and at most one accent element (ribbon, badge, or
fill) per panel. A faint paper-grain overlay is acceptable on large menu
panels only — never on in-race HUD (alpha noise over motion shimmers).

**Tilt:** hero badges (position, countdown, ribbons) sit at **−2° to −1°**
rotation — hand-placed, not typeset. Use sparingly: tilt the badge, never the
copy inside a reading panel, and never two adjacent elements.

## Typography

| Slot | Face | Use |
|---|---|---|
| Display | **Lilita One** | the six-foot read: position ordinal, countdown, headings, buttons, ribbons. Tight tracking (0–0.06em) — painted sign letters sit snug. The old 0.2–0.3em broadcast tracking is gone. |
| UI / body | **Nunito** 400–800 | labels (800 small-caps with 0.12–0.16em tracking), descriptions, stats, settings |
| Numerals | Lilita One / Nunito with `font-variant-numeric: tabular-nums` | anything that ticks (timers, gaps, counts) |
| Mono | JetBrains Mono (system fallback) | dev/debug chrome only — never player-facing |

Loaded from Google Fonts with the same async non-blocking swap as before.

## Voice

Race-day warm, scrappy-confident, never corporate-broadcast. The announcer is
a friend at the marina, not a network anchor.

- "PICK YOUR FORMAT / CHANNEL HBN 1" → **"RACE DAY / what are we running?"**
- "Back to the booth" → **"back at the docks"**
- Countdown GO! is `GO!` — punctuation is allowed to be excited.
- Labels stay short and concrete: COURSE, BIKE, LAPS, RIVALS, BEST.
- Body copy may be a sentence with a wink; labels and numbers never joke.

## Race HUD — inventory + layout

Desktop layout (mobile variants noted; minimap swaps to top-right on ≤720px):

```
 ┌────────────────────────────────────────────────────────────┐
 │ [POSITION 3rd/8]      [RACE/LAP timer board]               │
 │ [LAP 2/3 chip]            [gap pill ▲/▼]                   │
 │                                                            │
 │ [tutorial / cup-points chyrons — top-center stack]         │
 │                                                            │
 │ [boost meter]                              (world is the   │
 │ [drift badge]                               HUD: arrows,   │
 │                                             wake, shimmer) │
 │         [wave-pump / trick / tuck — bottom-center]         │
 │ [music credit]                          [minimap porthole] │
 └────────────────────────────────────────────────────────────┘
```

**P0 widgets (ship the skin + these):**

- **Position badge** *(new — the hero)*: huge Lilita ordinal (`3rd`) + `/8`,
  coral board, top-left, −2° tilt; **LAP 2/3** chip hangs beneath. Position
  changes pop the badge (scale pulse); gaining = mint flash, losing = hazard.
  Data already flows through `RaceHudInput` (`playerPosition`, `totalRacers`,
  `lap`, `lapsToFinish`).
- **Timer board** (restyled): RACE + LAP rows, tabular digits, top-center.
  Best/last lap in sun-gold.
- **Countdown** (restyled): stamped Lilita `3·2·1·GO!` — paint-stamp pop, GO!
  in mint. Start-lights variant keeps its lamps but loses the navy box for a
  painted plank.
- **Gap pill** (restyled): `▲ 0.42s` mint / `▼ 1.08s` hazard, under the timer.
- **Minimap porthole** (restyled): rounded-square porthole, deep-water fill,
  route stroked in sand-cream, racers as vinyl pin dots, cream keyline frame.
  Canvas-drawn in `race-hud.ts`; colorblind palette hooks unchanged.
- **Existing meters** (wave-pump, boost, drift, tuck, trick prompt, OOB,
  tutorial): retokened (rounded, painted accents, mint/coral/gold) — full
  bespoke redesign is P1; they're already well-placed.

**Deliberately not shown** (anti-clutter, mirrors design-targets anti-targets):
- **No speedometer.** Speed is read from the world — FOV, spray, wake, wind
  strokes. (The neon concept's SPEED dial dies with that direction.)
- **No health/damage, no item slots** (no such systems). If pickups ship, the
  slot is a painted supply-crate chip bottom-left, P2.
- **No persistent leaderboard list during the race** — position badge + gap
  pill carry it; the full board belongs to checkpoints (P1 "rival ticker")
  and the finish screen.

**P1 (next):** painted track-card vignettes in menus (crop the per-track MJ
art into the tiles); rival nameplate ticker on checkpoint pass; wave-window
indicator unified with the in-world crest shimmer; finish-line banner moment
(stitched banner drop on final lap + finish); positions list as an optional
toggle.

**P2:** photo-mode frame + painted watermark; spectate/replay chrome; podium
ceremony titles; livery-colored player accents in HUD.

## Menus

- **Frame:** header = painted plank (wordmark badge left, crumb flags center);
  footer chyron = rope-and-plank status bar. Both keep their grid + focus
  behavior — this is a reskin, not a re-flow.
- **Cards:** postcard tiles — rounded, cream keyline, image-led where art
  exists; selected = coral ring + mint focus glow when focused.
- **Buttons:** Lilita pills; primary = coral fill / navy text; focus = mint
  ring (the only glow).
- **Title screen:** wordmark in Lilita with a painted wave-stroke underline
  (inline SVG), tagline beneath; "press anything — let's ride" CTA.
- **Pause/finish/cup-results/settings:** same painted-board recipe; ribbons
  become real ribbon shapes (notched ends), champion row in sun-gold.
- **A11y data-attrs** (`large-text`, `high-contrast`, `reduced-flash`,
  `reduced-motion-override`, `cb-*`) and the two-poller gamepad rule are
  untouched and re-verified after any restyle.

## Motion

Keep the existing timing tokens (`--t-fast/base/slow`) — the *character*
changes: entrances are **stamp-pops** (scale 0.92 → 1.03 → 1 with overshoot)
and **drop-ins**, not slides-with-fade. One pop per element per event; no
idle pulsing except the focus glow and the CTA blink. Reduced-motion rules
flatten everything, as before.

## The name — pitch

"Hoverbike" is a placeholder; the prior key-art pass left **TIDE RIDERS** as
lead. Pitch, with the UI/logo consequences considered:

| Name | Read | Notes |
|---|---|---|
| **King Tide** ⭐ | the championship itself — a real term for the year's highest tide, reclaimed as the name of the show | Thesis in two words (the flood became the festival). Short, ownable, logo = crown-over-wave badge, cups slot under it ("Reef Cup, King Tide season"). **Recommendation.** |
| **Tide Riders** | Saturday-morning warm, says riders + water | Existing lead; safest, friendliest; slightly generic next to King Tide |
| **Hovertide** | mechanic + setting portmanteau | Most ownable/searchable; reads a bit "product name" |
| **Highwater** | "come hell or high water" defiance | Great tone, slightly somber alone; strong as "Highwater Circuit" |
| **Floodlight** | the neon's still on — flood + light | Cleverest wordplay; risks reading as a lighting brand |

**Wired in:** `src/engine/branding.ts` exports `GAME_TITLE` (currently
`KING TIDE`) + tagline — title screen, lobby overlay, loading screen, and the
HTML `<title>` all read from it (the two static `index.html` strings are
flagged with comments). Changing the name is a one-file edit.

## Verification

- `pnpm gen:ui-shots <label>` is the contact sheet: title → mode → track →
  bike → settings → intro → countdown → race HUD → pause, saved to
  `artifacts/ui-shots/<label>/`. Run it before/after any chrome change and
  diff by eye. It forces `--workers=1` — two parallel WebGPU boots can
  poison the water pipeline and black the canvas.
- Manual pass per [qa-playbook.md](./qa-playbook.md): real pad + touch on the
  full menu loop, a11y modes on (large text, high contrast, each colorblind
  mode), worst-case sun track (`nyc_sunset`) for HUD contrast.
