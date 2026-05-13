# Security policy

Hoverbike is a client-side browser game with a thin stateless WebSocket relay
(`party/relay.ts`). The threat model is small, but the game is deployed to a
public URL, so a few things are worth surfacing.

## Reporting a vulnerability

Please **don't** open a public GitHub issue for security problems. Instead:

- Open a **private security advisory**: <https://github.com/occ-matt/hoverbike/security/advisories/new>, or
- Email the repo owner via the GitHub profile.

A reply target of 7 days is reasonable for a hobby project; please be patient.

## In scope

- The Vite-bundled game served from `/dist/`.
- The PartyKit relay in `party/relay.ts`.
- The dev-only Vite middleware that lets `?edit=1` write track JSON back to disk
  (only active when `pnpm dev` is running locally).
- The Blender pipeline scripts under `tools/blender/` and the asset specs they
  read from `specs/`.

## Out of scope

- The Vercel preview / production deploys themselves (report platform issues to
  Vercel).
- Denial-of-service against the PartyKit relay (it's stateless and any peer can
  spam binary frames; we accept this for now — see
  [`docs/m10-11-state-sync.md`](docs/m10-11-state-sync.md) §9).
- Cheating via crafted `TransformSnapshot` packets — there's no server
  validation today; this is documented in the M10.11 design and the M10.13+
  roadmap covers owner-authoritative checks.
