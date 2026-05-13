# Contributing

This is the on-ramp for **code contributors**. If you're authoring
art assets (bikes, tracks, props) you probably want the
[Modding](../modding/overview) section instead.

The canonical contributor guide is the repo's
[`CONTRIBUTING.md`](https://github.com/occ-matt/hoverbike/blob/main/CONTRIBUTING.md)
— it covers setup, branch naming, commit style, and PR review.

This site adds the orientation a newcomer probably wants on day one:

- **[Architecture](./architecture)** — the load-bearing rules of the
  codebase. Read this before touching layer boundaries.
- **[Testing](./testing)** — what gets unit-tested vs. e2e-tested,
  what runs in CI, and how to write a new test.
- **[Code review](./code-review)** — what reviewers care about, what
  conventions PRs are expected to follow.

If you only have time for one page, read **Architecture**. The
sim-layer rule is the constraint most likely to surprise a newcomer.

## Filing issues

Use the templates:

- [Bug report](https://github.com/occ-matt/hoverbike/issues/new?template=bug.yml)
- [Feature / idea](https://github.com/occ-matt/hoverbike/issues/new?template=feature.yml)

For security issues, see
[`SECURITY.md`](https://github.com/occ-matt/hoverbike/blob/main/SECURITY.md)
— don't open public issues for those.

## Good first PRs

- Items in [`docs/blender-wishlist.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/blender-wishlist.md) — open
  roadmap for Blender automation.
- Items in [`docs/code-review-2026-05.md`](https://github.com/occ-matt/hoverbike/blob/main/docs/code-review-2026-05.md) —
  recent self-review punch list.
- Issues labelled `good first issue` or `help wanted` on GitHub.

Open a draft PR or a discussion early if you're not sure — easier to
course-correct before you've written a thousand lines.
