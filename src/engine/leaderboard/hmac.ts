/**
 * WebCrypto-backed HMAC-SHA256 signing + verification. Used by the
 * leaderboard client to authenticate submissions, and by the Party
 * server to validate them. Both runtimes (browser + Cloudflare
 * Worker via PartyKit) expose the same `crypto.subtle` API, so this
 * file is environment-agnostic.
 *
 * Threat model is "discourage scripted curl spam". A determined
 * cheater can extract the secret from the client bundle and forge
 * submissions — this isn't defence against that. Server-side
 * plausibility checks + the reactive admin wipe path are what
 * actually keep the board honest.
 */

const TEXT_ENCODER = new TextEncoder()

let cachedKey: CryptoKey | null = null
let cachedSecret = ''

async function importKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedSecret === secret) return cachedKey
  cachedKey = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  cachedSecret = secret
  return cachedKey
}

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < view.length; i++) {
    const v = view[i] ?? 0
    out += (v < 16 ? '0' : '') + v.toString(16)
  }
  return out
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(v)) return null
    out[i / 2] = v
  }
  return out
}

/** Sign a canonical payload string with `secret`. Returns the
 *  `sha256:<hex>` representation the wire format expects. */
export async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await importKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(payload))
  return `sha256:${bytesToHex(sig)}`
}

/** Verify a `sha256:<hex>` signature against `payload`. Constant-time
 *  comparison happens inside `crypto.subtle.verify`. Returns false on
 *  malformed signatures rather than throwing — the caller is going
 *  to bounce the request either way. */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const prefix = 'sha256:'
  if (!signature.startsWith(prefix)) return false
  const hex = signature.slice(prefix.length)
  const bytes = hexToBytes(hex)
  if (!bytes) return false
  const key = await importKey(secret)
  // Cast through unknown — `Uint8Array<ArrayBufferLike>` vs the lib.dom
  // `BufferSource` variant are byte-identical at runtime; the only
  // friction is TS's SharedArrayBuffer concession.
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes as unknown as ArrayBuffer,
    TEXT_ENCODER.encode(payload),
  )
}

/** 32-char (16-byte) hex nonce. Cryptographically random — used in
 *  the SubmitBody.nonce field so a replay attack inside the timestamp
 *  window can be detected server-side. */
export function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0
    out += (v < 16 ? '0' : '') + v.toString(16)
  }
  return out
}

/** Default secret for local dev. Deliberately bad so that anyone
 *  hitting the production board with this value lands no entries — the
 *  prod deploy must set `LEADERBOARD_HMAC_SECRET` (PartyKit env var)
 *  AND `VITE_LEADERBOARD_HMAC_SECRET` (build-time client env) to
 *  matching values. The two-half-key model is documented in
 *  `docs/leaderboard-backend.md`. */
export const DEV_HMAC_SECRET = 'hoverbike-dev-secret-do-not-ship'
