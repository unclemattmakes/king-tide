# Playtest card — wave-mastery legibility (pitch-the-jump)

> **What this is.** A focused, repeatable hands-on card for the one open P0
> question from [product-plan.md](./product-plan.md) §Success criteria and
> [water-next-research.md](./water-next-research.md) §5: under the v2
> motocross model (pitch the takeoff, pitch the landing), **does the water
> itself tell you where and when pitching pays?** Run it before tuning any
> more water-look knobs — the answers aim that work. Playtest > analysis:
> this card records what your hands felt, not what the tuner says.

## Setup

- Current `main`, headed, real GPU (`pnpm dev --port <N> --strictPort`).
- Track: **Mayday Bay** (`?track=sandbar&bike=racer`) — the classroom, Beaufort 1,
  crest-launch beats. One run each with `racer` (neutral) and `sparrow`
  (most-forgiving pump) to separate bike feel from water read.
- 3 laps, no items focus needed. Then one palate-cleanser lap on **The Maw**
  (big open swell) to test the read at scale.

## The questions (score each 1–5, note the moment it happened)

1. **Forward read** — approaching open water, could you point at the swell
   you were *going to* launch off, ~2 s ahead? Or did launches happen to you?
2. **Takeoff read** — at the crest, did you know *when* to pitch back?
   What told you — geometry, foam, shading, HUD, or memory from a prior lap?
3. **Landing read** — mid-air, could you see where the water would receive
   you (down-slope vs face-slap), and did nose-down feel like it mattered?
4. **Reward read** — after a well-pitched launch+landing, did the game
   *acknowledge* it (speed you can feel, VFX, audio)? Within how long?
5. **Counterfactual** — deliberately fumble one: flat pitch off a crest,
   nose-up landing. Is the punishment legible (obvious speed loss / slap)
   or just vaguely worse?

## Record

- Scores + one line per question naming the *signal* you actually used.
- Any moment you pitched on purpose and couldn't tell if it worked — timestamp it.
- One sentence: on lap 3, were you reading the water or the racing line?

## Interpreting → work aim

| Result | Aim the work at |
|---|---|
| Q1 weak | forward water read: value ramp / contour foam / whitecap grammar (water-next §5 P1) — the *surface* must carry it, no HUD fan |
| Q2 weak | crest-moment cue: foam/spec highlight at the lip, audio tick |
| Q3 weak | landing legibility: receiving-slope shading, shadow/foam target |
| Q4 weak | reward channel: pump signal refit (post-launch chyron/VFX timing) |
| Q5 weak | failure feedback: slap VFX/audio + visible speed scrub |

If Q1–Q3 all read ≥4 with the racer, the mechanic is legible and remaining
work is reward polish (Q4/Q5) — stop tuning water-look for legibility reasons.
