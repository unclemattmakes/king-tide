/**
 * Contact-splash driver — spray when a wave slams a waterline obstacle.
 *
 * The GPU foam collar (water.ts `contactFoam`) makes obstacles *sit* in the
 * sea; this driver makes the sea *hit* them. Per water contact
 * (water-contacts.ts) it samples the wave field each frame and fires a
 * one-off burst the moment the surface both stands tall AND is still rising
 * fast against the obstacle — the crest's slam, not its calm passage. The
 * rising-edge hysteresis + cooldown give exactly one burst per crest per
 * pillar, the same per-site arming scheme as `surge-spray.ts` /
 * `wave-crest-spray.ts`.
 *
 * Pure logic with injected deps — a `sample(x, z)` surface probe (height +
 * vertical surface velocity) and an `emit(contact, surfaceY, strength)`
 * callback — so it unit-tests without Three.js or the wave field. Render-only:
 * never writes the sim, doesn't need netcode determinism (peers see their own
 * spray, like crest spray).
 */

import type { WaterContact } from './water-contacts'

/** Per-probe result the driver consumes. `y` is the world surface height at
 *  the contact; `vy` is ∂y/∂t, the surface's own vertical velocity. */
export type ContactSplashSample = { y: number; vy: number }

export type ContactSplashConfig = {
  /** Height above still water (m) the surface must reach to fire. */
  fireHeight?: number
  /** Upward surface velocity (m/s) required at fire time — the "slam". */
  fireVy?: number
  /** Height (m) at which burst strength saturates to 1. */
  fullHeight?: number
  /** Height (m) the surface must fall back below to re-arm a contact. */
  rearmHeight?: number
  /** Minimum seconds between two bursts on the same contact. */
  cooldownS?: number
  /** Cap on bursts per tick across all contacts, so a set wave arriving
   *  everywhere at once can't dump the whole spray pool in one frame. */
  maxFiresPerTick?: number
  /** Contacts farther than this from the view centre aren't sampled. */
  cullRadiusM?: number
}

export type ContactSplashDriver = {
  /** Advance at field clock `time` (s), with view centre (`cx`, `cz`) for
   *  distance culling. */
  tick(cx: number, cz: number, time: number): void
  /** Swap the contact list (e.g. dev-hook injection). Resets arming state. */
  setContacts(contacts: readonly WaterContact[]): void
  /** Total bursts fired since creation — for e2e/diagnostics. */
  firedCount(): number
}

type ContactState = {
  contact: WaterContact
  armed: boolean
  prevH: number
  lastFire: number
}

export function createContactSplashDriver(opts: {
  contacts: readonly WaterContact[]
  /** Still-water base height (field.baseY) the fire thresholds are relative to. */
  baseY: number
  sample: (x: number, z: number) => ContactSplashSample
  emit: (contact: WaterContact, surfaceY: number, strength: number) => void
  config?: ContactSplashConfig | undefined
}): ContactSplashDriver {
  const fireHeight = opts.config?.fireHeight ?? 0.34
  const fireVy = opts.config?.fireVy ?? 0.5
  const fullHeight = opts.config?.fullHeight ?? 1.15
  const rearmHeight = opts.config?.rearmHeight ?? 0.1
  const cooldownS = opts.config?.cooldownS ?? 1.1
  const maxFiresPerTick = opts.config?.maxFiresPerTick ?? 6
  const cullRadius = opts.config?.cullRadiusM ?? 120
  const cullRadiusSq = cullRadius * cullRadius

  let states: ContactState[] = bind(opts.contacts)
  let fired = 0
  // Rotating scan offset so the per-tick fire cap doesn't permanently
  // starve contacts that happen to sit late in the list.
  let scanStart = 0

  function bind(contacts: readonly WaterContact[]): ContactState[] {
    return contacts.map((contact) => ({
      contact,
      // Born disarmed: a contact that enters the world mid-crest waits for
      // the next trough → next crest, instead of firing on first sight.
      armed: false,
      prevH: 0,
      lastFire: -Infinity,
    }))
  }

  function tick(cx: number, cz: number, time: number): void {
    const n = states.length
    if (n === 0) return
    let fires = 0
    for (let k = 0; k < n; k++) {
      const st = states[(k + scanStart) % n]!
      const c = st.contact
      const dx = c.x - cx
      const dz = c.z - cz
      if (dx * dx + dz * dz > cullRadiusSq) continue
      const s = opts.sample(c.x, c.z)
      const h = s.y - opts.baseY
      if (
        st.armed &&
        h >= fireHeight &&
        s.vy >= fireVy &&
        time - st.lastFire >= cooldownS &&
        fires < maxFiresPerTick
      ) {
        // Strength blends how TALL the water stands with how HARD it's
        // rising — a slow fat swell reads softer than a steep slap.
        const hT = clamp01((h - fireHeight) / Math.max(1e-3, fullHeight - fireHeight))
        const vT = clamp01(s.vy / 3)
        opts.emit(c, s.y, clamp01(0.25 + 0.45 * hT + 0.3 * vT))
        st.armed = false
        st.lastFire = time
        fires++
        fired++
      } else if (!st.armed && h <= rearmHeight) {
        st.armed = true
      }
      st.prevH = h
    }
    scanStart = (scanStart + 1) % n
  }

  return {
    tick,
    setContacts(contacts) {
      states = bind(contacts)
      scanStart = 0
    },
    firedCount: () => fired,
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
