/**
 * Singleton resolver for the leaderboard Party endpoint. Centralizes
 * the dev-vs-prod host pick + the HMAC secret read so feature code
 * just calls `getEndpoint()` and gets the right wiring for the
 * current build mode.
 *
 *  - In dev (`import.meta.env.DEV`), the host points at the local
 *    PartyKit dev server (`localhost:1999`) and the secret falls
 *    through to `DEV_HMAC_SECRET`.
 *  - In prod, the host is the deployed `*.partykit.dev` domain and the
 *    secret comes from `VITE_LEADERBOARD_HMAC_SECRET`, embedded at
 *    build time. If that is missing the remote board is **disabled**
 *    for the build (local cache only) rather than signed with the dev
 *    constant — the server refuses unsigned-in-practice writes now, so
 *    submitting would only generate noise and misleading failures.
 *
 * Because the dev secret is only read under `import.meta.env.DEV`, Vite
 * eliminates that branch in a production build and the constant never
 * reaches the shipped bundle.
 *
 * The `?host=` URL override mirrors the multiplayer client's behaviour
 * — dev convenience for testing against a staging Party from a prod
 * build. The `?leaderboard=local` override forces local-cache-only
 * mode (skips remote even when an endpoint is reachable), useful for
 * QA of the offline-fallback path.
 */

import { DEV_HMAC_SECRET } from './hmac'
import type { RemoteEndpoint } from './remote'

const PROD_HOST = 'hoverbike.occ-matt.partykit.dev'

let cached: { endpoint: RemoteEndpoint; remoteEnabled: boolean } | null = null

function resolve(): { endpoint: RemoteEndpoint; remoteEnabled: boolean } {
  if (cached) return cached
  let host = PROD_HOST
  let remoteEnabled = true
  // Assigned below: the build-time env secret, or the dev constant, but the
  // dev constant strictly under `import.meta.env.DEV` so it is dead code —
  // and therefore absent — in a production bundle.
  let secret = ''
  try {
    if (typeof window !== 'undefined' && window.location) {
      const params = new URLSearchParams(window.location.search)
      const override = params.get('host')
      if (override) host = override
      const mode = params.get('leaderboard')
      if (mode === 'local') remoteEnabled = false
    }
  } catch {
    /* SSR / non-DOM contexts — fall through to defaults */
  }
  if (import.meta.env.DEV) {
    host = host === PROD_HOST ? 'localhost:1999' : host
  }
  const envSecret = import.meta.env.VITE_LEADERBOARD_HMAC_SECRET
  if (typeof envSecret === 'string' && envSecret.length > 0) {
    secret = envSecret
  } else if (import.meta.env.DEV) {
    // Local `partykit dev` runs with the same constant, so the pair matches.
    secret = DEV_HMAC_SECRET
  } else {
    // Production build with no signing key. Previously we signed with the
    // dev constant anyway and hoped the server would say no — it didn't,
    // because it fell back to the same constant. Now the server refuses
    // ('unconfigured'), so submitting would be pure noise: turn the remote
    // board off and keep the local best instead. Same path as
    // `?leaderboard=local`, so the UI already handles it.
    remoteEnabled = false
    console.warn(
      '[leaderboard] VITE_LEADERBOARD_HMAC_SECRET not set — remote board disabled for this build; personal bests stay local. Set it (and the matching LEADERBOARD_HMAC_SECRET on the Party) to enable the global board.',
    )
  }
  cached = {
    endpoint: { host, secret },
    remoteEnabled,
  }
  return cached
}

export function getEndpoint(): RemoteEndpoint {
  return resolve().endpoint
}

/** True iff the remote leaderboard should be used (no `?leaderboard=local`
 *  override). When false, both submit + fetch silently skip the network
 *  and the menu view + finish overlay fall back to local-only. */
export function isRemoteEnabled(): boolean {
  return resolve().remoteEnabled
}

/** Test-only — reset the resolver cache so a `?host=` override change
 *  picks up. Not exported to JSX; callers use the URL override path
 *  in non-test code. */
export function __resetEndpointForTests(): void {
  cached = null
}
