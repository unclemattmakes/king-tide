# Building a track from scratch — *(archived → see level-design-playbook)*

> **Archived / superseded (2026-06).** This Cape Hatteras–era "four-pass" playbook
> has been consolidated into the canonical, current workflow:
> **[level-design-playbook.md](level-design-playbook.md)** — *building a track from
> a shape-only canvas*.
>
> Its still-valid, hard-won gotchas were folded into that doc ("Before you start"
> + §8): orphan datablocks breaking the terrain finders, `cp_NN` needing an
> `index` prop, the export **merge-not-stomp** trap, a missing `props-library.blend`,
> and exports landing in the configured clone rather than your worktree.
>
> What did **not** carry over: its **"Set-pieces (anti-grav)"** step —
> **anti-grav is cut** (parked for a possible DLC; no shipped track places
> anti-grav zones), so don't author it. (It also referenced `pnpm
> seed:props-library`, which no longer exists; the correct invocation is
> `node tools/blender/seed.mjs seed_props_library.py`.)
>
> The original four-pass content remains in git history. Don't author from this
> file — start at [level-design-playbook.md](level-design-playbook.md).
