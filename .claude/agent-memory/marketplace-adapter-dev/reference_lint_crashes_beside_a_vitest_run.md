---
name: lint-crashes-beside-a-vitest-run
description: apps/web `npm run lint` can die with an eslint globMultiSearch stack trace when a vitest run in the same tree creates/removes apps/web/.vitest/ mid-walk; rerun lint alone
metadata:
  type: reference
---

`eslint .` in apps/web walks every directory, including the transient
`apps/web/.vitest/` cache a vitest run creates and removes. Run lint while a
vitest run (yours, or a parallel builder's in the shared worktree) is active
and it can exit with a stack trace through `globMultiSearch` / `findFiles`
and no lint findings at all.

**How to apply:** that trace is not a lint result. Rerun `npm run lint` on its
own, after the vitest run ends; only a rerun's findings count. Don't chain
lint after vitest with `;` in the same call when other builders share the
worktree. Related: [[eslint-does-not-cover-plain-ts]].
