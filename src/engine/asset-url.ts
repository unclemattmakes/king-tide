/**
 * Resolve a public asset path to the URL it should be fetched from.
 *
 * The heavy binary assets the game loads at runtime — track / bike / prop
 * GLBs, texture atlases, thumbnail JPGs (`/assets/**`) and the compiled
 * soundtrack + ambience (`/audio/**`) — are hosted on Cloudflare R2 in
 * production so Vercel deploys never re-pull them through git-LFS (the LFS
 * bandwidth blowup this indirection exists to fix). `VITE_ASSET_BASE_URL`
 * holds the R2 public origin (e.g. `https://assets.hoverbike.gg`).
 *
 * In dev, tests, and any build without the env var set, the base is empty
 * and these same app-absolute paths resolve against Vite's local `public/`
 * dir — so the game runs fully offline with no R2 dependency.
 *
 * Gameplay JSON under `/tracks/*.json` is deliberately NOT routed here:
 * it's small, versioned source-of-truth data that stays in the deploy.
 * Only call `assetUrl()` on paths that are actually mirrored to R2.
 *
 * NOTE for cross-origin (prod): the R2 bucket must send permissive CORS
 * headers (`Access-Control-Allow-Origin`) for the deploy domain, or the
 * browser blocks GLB/audio/atlas fetches. The soundtrack jukebox
 * additionally sets `crossOrigin="anonymous"` on its `<audio>` element —
 * without it, cross-origin media routed through Web Audio is tainted to
 * silence. See `docs/asset-storage.md`.
 */

function readAssetBaseUrl(): string {
  try {
    // Static access so Vite inlines the literal at build time. Undefined
    // (no env var) and non-Vite contexts both fall through to ''.
    const raw = import.meta.env.VITE_ASSET_BASE_URL
    return typeof raw === 'string' ? raw : ''
  } catch {
    return ''
  }
}

/**
 * Join an asset base origin with an app-absolute asset path, tolerating a
 * trailing slash on the base and a missing leading slash on the path. An
 * empty base returns the path unchanged (the local/offline case).
 *
 * Exported for unit tests; call `assetUrl()` at runtime sites.
 */
export function joinAssetUrl(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, '')
  if (!b) return path
  return path.startsWith('/') ? `${b}${path}` : `${b}/${path}`
}

/** Resolved once at module load — env is a build-time constant. */
const ASSET_BASE_URL = readAssetBaseUrl()

/**
 * Prefix an app-absolute asset path (`/assets/...` or `/audio/...`) with
 * the configured asset base. A no-op when no base is set, so dev/test use
 * the local copy unchanged.
 */
export function assetUrl(path: string): string {
  return joinAssetUrl(ASSET_BASE_URL, path)
}
