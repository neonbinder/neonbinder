---
name: apps-web-root-tsc-is-red-at-baseline
description: In apps/web, `npx tsc --noEmit -p .` is red on a clean checkout (pre-existing errors in convex/*.test.ts, app/print/labels/page.test.tsx + vite.config.ts; 39 in Aug, 65 on 2026-09-04, 153 on 2026-09-08 — the count drifts, re-measure before quoting); the real Convex typecheck gate is `npx tsc -p convex/tsconfig.json --noEmit`
metadata:
  type: reference
---

`npx tsc --noEmit -p .` run from `apps/web` exits non-zero on an untouched
checkout — 39 errors when this was written, 65 as of 2026-09-04, and none of
them are yours. The count drifts upward as test files are added, so compare
against `main` rather than against a remembered number. Three clusters:

- `convex/*.test.ts` files that call `ctx.db.query(...).withIndex("by_foo", …)`
  inside a `t.run()` callback. The callback's `ctx` types as the *system*
  context, so every real index name is rejected against `keyof SystemIndexes`
  (`"by_user"`, `"by_selector_option"`, `"by_level_and_parent"`, …), along with
  a scattering of `TS7006` implicit-any callback params.
- `app/print/labels/page.test.tsx` fixtures missing required object fields.
- `vite.config.ts` (plugin union typing, implicit-any `p`).

Also expect stale-codegen noise layered on top when another agent is mid-edit
on `schema.ts` — e.g. `Property 'swapPairSides' does not exist` — see
[[convex-codegen-only-blocks-types]].

**Why it matters:** it is NOT a CI gate and never has been. The documented
apps/web gates are `npm run lint`, `npm run test:unit`, `npm run build`, and
`npx tsc -p convex/tsconfig.json --noEmit`. Only the last typechecks Convex
code, and that one IS clean.

**How to apply:** if a task or coordinator asks for `tsc --noEmit -p .`, run it
but treat `convex/tsconfig.json` as the signal, and report the root run's red
exit as pre-existing rather than a regression — after confirming none of the
error paths are files you touched (`git status --porcelain` is the fast check
in a shared worktree). To get a true baseline without disturbing concurrent
agents: `git worktree add --detach <scratchpad>/baseline HEAD`, symlink
`node_modules`, copy `convex/_generated` in, run tsc there, then
`git worktree remove --force`. When diffing, strip line/column numbers and look
for new *files and error codes* — adding a table to `schema.ts` renumbers
`... 18 more ...` inside unrelated pre-existing messages.
