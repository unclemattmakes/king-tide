/**
 * Dev-runtime bridge — live controllers the running game loop registers for
 * the dev palette to drive.
 *
 * Some dev toggles can't be flipped from outside the render loop: the
 * sim-surface probe (`?wavedots`) follows the player and must be ticked every
 * frame with the live wave field + player centre, both of which only exist
 * inside `startGameLoop`. So the loop registers a tiny controller here and the
 * palette reads it — same decoupling as the water / sky service singletons,
 * scoped to dev tooling.
 *
 * A `null` controller (no loop running, or a non-dev build) means the matching
 * palette tool simply no-ops.
 */

/** Create/destroy + state for a loop-owned live toggle. `toggle` returns the
 *  new on-state. */
export type LiveToggle = {
  isOn(): boolean
  toggle(): boolean
}

let waveDots: LiveToggle | null = null

export function setWaveDotsController(c: LiveToggle | null): void {
  waveDots = c
}

export function getWaveDotsController(): LiveToggle | null {
  return waveDots
}

// Ambient wind-gust strokes (engine/render/wind-trails.ts) — registered by
// main.ts at boot so the palette can flip them live (`?wind=0` only sets the
// boot default).
let windTrails: LiveToggle | null = null

export function setWindTrailsController(c: LiveToggle | null): void {
  windTrails = c
}

export function getWindTrailsController(): LiveToggle | null {
  return windTrails
}
