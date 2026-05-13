# Code review

The summary: small PRs, clear commits, tests for sim changes, manual
verification for UI changes.

## What reviewers look for

1. **One concern per PR.** A PR that does "add boost pads AND fix
   menu layout AND refactor `main.ts`" is three PRs. Split.
2. **A test plan that's been run.** The PR template has a checklist.
   At minimum, typecheck + lint + test must have run. For sim /
   physics / race / netcode changes, also run `pnpm e2e` locally.
3. **No new Three.js imports in sim code.** This is the one
   non-negotiable architectural rule — see
   [Architecture](./architecture).
4. **Minimal diff.** If the PR description is "fix bug X" but the
   diff also reformats a thousand lines, those should be separate
   commits or separate PRs.
5. **Commit messages tell the story.** A reviewer should be able to
   read the commit list and understand what happened, in what order.

## Commit conventions

Loose [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): short imperative summary

Optional body explaining the WHY. The WHAT should be obvious from
the diff; the body is for context the diff can't carry.
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `test`.

Common scopes: `sim`, `render`, `net`, `hud`, `menu`, `editor`,
`audio`, `controls`, `ai`, `combat`, `track`, `bike`, `blender`.
Invent a new scope if none fits.

Keep the subject under ~70 characters. Wrap the body at ~72.

## Reviewing your own PR

Before requesting a review, **read your own diff** on the PR page.
You'll catch:

- Debug `console.log` you forgot to remove.
- Commented-out code blocks.
- Whitespace-only changes mixed in with substantive ones.
- Files that shouldn't have been committed (test fixtures, .DS_Store).

If you'd flag it in someone else's PR, fix it before asking.

## After merge

- `main` is the deploy branch. Pushes to it auto-deploy the game and
  docs site to Vercel.
- Hot-fix workflow: branch off `main`, PR, merge, deploy is automatic.
- Don't force-push to `main`. Force-push to your own branches is fine
  if it cleans up history before merge.

## Disagreements

Disagreements about scope, approach, or style are expected and
healthy. State your reasoning concretely (a benchmark, a screenshot,
a quote from a doc) rather than appealing to taste. The project
owner has the final call when consensus isn't reached.
