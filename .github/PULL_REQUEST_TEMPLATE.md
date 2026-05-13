<!--
Thanks for the PR! A short checklist to keep the review tight.
Delete sections that don't apply.
-->

## What

<!-- One or two sentences. What does this change do? -->

## Why

<!-- The reason. Link any issue or design doc.
     Examples: closes #42 / part of docs/m10-11-state-sync.md / playtest feedback. -->

## How

<!-- Bullet points of the approach, only if non-obvious from the diff. -->

## Test plan

<!-- What you did to convince yourself this works. -->
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Manually played the affected feature in `pnpm dev` (browser screenshot helpful for UI)
- [ ] `pnpm e2e` (if you touched sim, physics, race, or netcode)

## Notes for the reviewer

<!-- Anything you'd like the reviewer to look at especially carefully,
     or tradeoffs you considered. -->
