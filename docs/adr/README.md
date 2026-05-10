# Architecture Decision Records

Short notes on the load-bearing technical decisions in this codebase.
Future contributors should read these before swapping out a major
dependency, splitting a layer, or arguing in a PR comment.

ADRs are retroactively written — they capture the rationale as
understood today, not a historical meeting. If a decision is
revisited and overturned, leave the old ADR in place and add a new
one that supersedes it.

## Index

| #    | Title                                       | Status   |
|------|---------------------------------------------|----------|
| 0001 | ECS — bitECS 0.4 with side-table stores     | Accepted |
| 0002 | Sim layer must not import Three.js          | Accepted |
| 0003 | Renderer — Three.js, WebGPU-first           | Accepted |
| 0004 | Physics — Rapier3D-compat (deterministic)   | Accepted |

## Format

Each ADR is one screen of markdown:

- **Context** — what problem the decision addresses, what the
  alternatives looked like.
- **Decision** — the chosen path, stated plainly.
- **Consequences** — what follows from the choice, including the
  costs and the constraints it imposes on future work.
