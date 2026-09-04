---
name: apps-web-root-tsc-is-not-a-gate
description: `npx tsc --noEmit -p .` in apps/web is red at baseline (~39 errors); the real typecheck gate is `npx tsc -p convex/tsconfig.json --noEmit`
metadata:
  type: project
---

In `apps/web`, `npx tsc --noEmit -p .` exits 2 on a clean checkout — around 39
pre-existing errors, concentrated in `convex/*.test.ts` files (they type
`ctx.db.query(...).withIndex()` against bare `SystemIndexes`, so every real
index name is rejected) plus `vite.config.ts`. It is NOT a CI gate and never
has been.

**Why:** the documented apps/web gates are `npm run lint`, `npm run test:unit`,
`npm run build`, and `npx tsc -p convex/tsconfig.json --noEmit`. Only the last
one typechecks the Convex code, and it IS clean — so a schema change that
compiles there is genuinely fine.

**How to apply:** when asked to prove a schema change breaks nothing, run the
`convex/tsconfig.json` typecheck as the real signal. If you also run the root
`-p .` typecheck, don't report its red exit as a regression — diff it against a
baseline first. Cheap way to get a baseline without disturbing a shared
worktree (other agents may be editing it concurrently): `git worktree add
--detach <scratchpad>/baseline HEAD`, symlink `node_modules` and copy
`convex/_generated` in, run tsc there, then `git worktree remove --force`.

One gotcha when diffing: adding a table to `schema.ts` changes rendered union
types inside *unrelated* pre-existing error messages (`... 18 more ...` becomes
`... 19 more ...`). Strip line/column numbers and read the diff for new *files
and error codes*, not exact message text.
