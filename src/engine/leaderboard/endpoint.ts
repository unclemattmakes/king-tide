/**
 * Singleton resolver for the leaderboard Party endpoint. Centralizes
 * the dev-vs-prod host pick + the HMAC secret read so feature code
 * just calls `getEndpoint()` and gets the right wiring for the
 * current build mode.
 *
 *  - In dev (`import.meta.env.DEV`), the host points at the local
 *    PartyKit dev server (`localhost:1999`) and the secret falls
 *    through to `DEV_HMAC_SECRET`.
 *  - In prod, the host is the deployed `*.partykit.dev` domain. The
 *    secret comes from `VITE_LEADERBOARD_HMAC_SECRET`, which is
 *    embedded at build time. Missing/empty env var → also falls
 *    through to the dev secret, with a console warning so the deploy
 *    pipeline notices.
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
  let secret = DEV_HMAC_SECRET
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
  } else if (!import.meta.env.DEV) {
    console.warn(
      '[leaderboard] VITE_LEADERBOARD_HMAC_SECRET not set — falling back to the dev secret. Submissions will be rejected by a properly-deployed server.',
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
