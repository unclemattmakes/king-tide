#!/usr/bin/env node
/**
 * Moderation CLI for the leaderboard Party.
 *
 * Wraps the admin HTTP endpoints on `/parties/leaderboard/global` so a
 * human reviewer can wipe a handle, remove a single row, block or
 * unblock a handle, or skim the audit log. All admin endpoints
 * require the `LEADERBOARD_ADMIN_TOKEN` bearer secret — read from
 * the environment.
 *
 * Usage examples:
 *
 *   pnpm leaderboard:moderate audit --limit 50
 *   pnpm leaderboard:moderate wipe-handle SLURXYZ
 *   pnpm leaderboard:moderate wipe-entry the-maw 3
 *   pnpm leaderboard:moderate block SLURXYZ
 *   pnpm leaderboard:moderate blocklist
 *   pnpm leaderboard:moderate unblock TST
 *
 * Override the host with `--host=<host>` (default
 * `hoverbike.occ-matt.partykit.dev`). For dev:
 *   pnpm leaderboard:moderate audit --host=localhost:1999
 */

const DEFAULT_HOST = 'hoverbike.occ-matt.partykit.dev'

function usage() {
  console.error(`leaderboard-moderate <command> [args]

Commands:
  audit [--limit N]                 — print recent submissions (default 100)
  wipe-handle <HANDLE>              — remove every entry by HANDLE + block future submissions
  wipe-entry <trackId> <rank>       — remove one row by 1-indexed rank
  block <HANDLE>                    — add HANDLE to the blocklist
  unblock <HANDLE>                  — remove HANDLE from the blocklist
  blocklist                         — print every blocked handle

Flags:
  --host=<host>                     — override host (dev: localhost:1999)
  --token=<value>                   — override admin token (default: $LEADERBOARD_ADMIN_TOKEN)
`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = []
  const flags = {}
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else flags[a.slice(2)] = true
    } else {
      args.push(a)
    }
  }
  return { args, flags }
}

function partyUrl(host, suffix) {
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}/parties/leaderboard/global${suffix}`
}

async function adminFetch(host, token, method, suffix, body) {
  const res = await fetch(partyUrl(host, suffix), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let parsed
  try {
    parsed = await res.json()
  } catch {
    parsed = { raw: await res.text() }
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, JSON.stringify(parsed, null, 2))
    process.exit(1)
  }
  return parsed
}

function fmtTs(ms) {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2))
  const cmd = args[0]
  if (!cmd) usage()
  const host = flags.host ?? DEFAULT_HOST
  const token = flags.token ?? process.env.LEADERBOARD_ADMIN_TOKEN
  if (!token) {
    console.error('LEADERBOARD_ADMIN_TOKEN not set. Pass --token=<value> or export the env var.')
    process.exit(2)
  }
  switch (cmd) {
    case 'audit': {
      const limit = Number(flags.limit ?? 100)
      const res = await adminFetch(host, token, 'GET', `/admin/audit?limit=${limit}`)
      const entries = res.entries ?? []
      if (entries.length === 0) {
        console.log('(no audit entries)')
        return
      }
      const widths = { ts: 24, ip: 16, outcome: 12, track: 22, handle: 14, lap: 8 }
      const header = [
        'TS'.padEnd(widths.ts),
        'IP'.padEnd(widths.ip),
        'OUTCOME'.padEnd(widths.outcome),
        'TRACK'.padEnd(widths.track),
        'HANDLE'.padEnd(widths.handle),
        'LAP'.padEnd(widths.lap),
      ].join('  ')
      console.log(header)
      console.log('-'.repeat(header.length))
      for (const e of entries) {
        console.log(
          [
            fmtTs(e.ts).padEnd(widths.ts),
            (e.ip ?? '?').padEnd(widths.ip),
            (e.outcome ?? '?').padEnd(widths.outcome),
            (e.trackId ?? '?').slice(0, widths.track).padEnd(widths.track),
            (e.handle ?? '?').slice(0, widths.handle).padEnd(widths.handle),
            String(e.bestLap ?? '').padEnd(widths.lap),
          ].join('  '),
        )
      }
      return
    }
    case 'wipe-handle': {
      const handle = args[1]
      if (!handle) usage()
      const res = await adminFetch(
        host,
        token,
        'DELETE',
        `/admin/handle/${encodeURIComponent(handle)}`,
      )
      console.log(`wiped + blocked ${res.handle} across ${res.tracksTouched} track(s)`)
      return
    }
    case 'wipe-entry': {
      const trackId = args[1]
      const rank = args[2]
      if (!trackId || !rank) usage()
      const res = await adminFetch(
        host,
        token,
        'DELETE',
        `/admin/entry/${encodeURIComponent(trackId)}/${encodeURIComponent(rank)}`,
      )
      console.log(`removed: ${JSON.stringify(res.removed)}`)
      return
    }
    case 'block': {
      const handle = args[1]
      if (!handle) usage()
      const res = await adminFetch(host, token, 'POST', '/admin/block', { handle })
      console.log(`blocked ${res.handle} · blocklist size: ${res.blocklistSize}`)
      return
    }
    case 'unblock': {
      const handle = args[1]
      if (!handle) usage()
      const res = await adminFetch(
        host,
        token,
        'DELETE',
        `/admin/block/${encodeURIComponent(handle)}`,
      )
      if (res.removed) {
        console.log(`unblocked ${res.handle} · blocklist size: ${res.blocklistSize}`)
      } else {
        // Idempotent server-side; say so plainly rather than claiming a
        // removal that didn't happen (usually a typo'd handle).
        console.log(`${res.handle} was not on the blocklist · blocklist size: ${res.blocklistSize}`)
      }
      return
    }
    case 'blocklist': {
      const res = await adminFetch(host, token, 'GET', '/admin/blocklist')
      const handles = res.handles ?? []
      if (handles.length === 0) {
        console.log('(blocklist is empty)')
        return
      }
      for (const h of handles) console.log(h)
      console.log(`\n${handles.length} blocked handle(s)`)
      return
    }
    default:
      usage()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
