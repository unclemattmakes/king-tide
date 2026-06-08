/**
 * Sky-system service singleton — same pattern as `water-service.ts`. The
 * `SkySystem` built during boot is stashed here so dev tooling (the palette's
 * live "Time of day" control) can re-apply the sky state without prop-drilling
 * the handle through `main.ts → game-loop → palette`.
 *
 * `main.ts` calls `setSkySystem(sky)` right after `createSkySystem()`.
 * Consumers tolerate `null` (the service is empty before boot, and on any
 * path that never builds a sky).
 */

import type { SkySystem } from './sky'

let instance: SkySystem | null = null

export function setSkySystem(sky: SkySystem | null): void {
  instance = sky
}

export function getSkySystem(): SkySystem | null {
  return instance
}
