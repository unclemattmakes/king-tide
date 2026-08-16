# Controls

The bike accepts three input sources at once: keyboard, gamepad, and mouse (camera only). They merge per-frame, so you can switch without a reset.

All keyboard axes are **smoothed with a ~0.13 s ramp** — taps give small inputs, holds give full deflection. Gamepad axes are raw (the deadzone + stick curve do the smoothing).

## Keyboard

| Key | Action |
|---|---|
| `W` / `↑` | Throttle forward |
| `S` / `↓` | Brake / reverse |
| `A` / `←` | Steer left |
| `D` / `→` | Steer right |
| `Q` | Pitch — **dive** (nose down) |
| `E` | Pitch — **lift** (nose up, extend air time) |
| `Space` | Fire pickup |
| `Shift` | Boost |
| `Backspace` | Respawn at start (snaps to spawn pose, zero velocity) |
| `T` or `F1` | Toggle auto-play (AI drives the player bike) |
| `M` | Toggle audio mute |
| `R` | Restart race after finish |

::: warning Pitch is empirical
`Q` reads as "dive" and `E` as "lift" because they match what you see on screen and what the math wants — the nose's actual `+Y` direction lifts on `E`. If a code comment says otherwise (`keyboard.ts` and `intent.ts` describe rider body action, not bike pitch), trust the table above.
:::

## Gamepad (Xbox / PS layout)

| Input | Action |
|---|---|
| Left stick X | Steer |
| Left stick Y | Pitch (push forward = dive, pull back = lift) |
| Right trigger | Throttle |
| Left trigger | Brake / reverse |
| Right stick | Camera orbit (Y inverted by default) |
| `A` / `X` (button 0) | Fire pickup |
| `B` / `Circle` (button 1) | Boost |

The build is **gamepad-first** — the hover physics, AI tuning, and trail responsiveness all assume continuous-axis input. Keyboard works, but gamepad is the intended feel.

## Mouse

| Action | Effect |
|---|---|
| Right-button drag | Orbit the chase camera around the bike (Y inverted by default) |

Mouse only controls the camera. Throttle / steer / pitch are not bound to mouse.

## Touch

There's a virtual stick driver in [`src/engine/input/touch.ts`](https://github.com/unclemattmakes/king-tide/blob/main/src/engine/input/touch.ts) that already merges into the input stream, but **no on-screen overlay is rendered** today. Mobile is not yet a first-class target — see [Platform & browser support](/build/platform).
